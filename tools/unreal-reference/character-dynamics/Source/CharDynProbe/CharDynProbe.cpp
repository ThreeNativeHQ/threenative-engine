#include "CharDynProbe.h"

#include "Animation/AnimSequence.h"
#include "AnimationRuntime.h"
#include "AssetCompilingManager.h"
#include "ClothingAsset.h"
#include "ClothingAssetFactoryInterface.h"
#include "ClothingSystemEditorInterfaceModule.h"
#include "Animation/SkeletalMeshActor.h"
#include "Components/SkeletalMeshComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/Engine.h"
#include "Engine/SkeletalMesh.h"
#include "Engine/World.h"
#include "GameFramework/WorldSettings.h"
#include "JsonObjectConverter.h"
#include "Misc/FileHelper.h"
#include "Modules/ModuleManager.h"
#include "PhysicsEngine/PhysicsAsset.h"
#include "PhysicsEngine/SkeletalBodySetup.h"
#include "Rendering/SkeletalMeshModel.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "SkeletalMeshClothingSystemUtilities.h"

IMPLEMENT_MODULE(FDefaultModuleImpl, CharDynProbe);

static constexpr int32 GCols = 11;
static constexpr int32 GRows = 19;
static const FName GCapeSlot(TEXT("M_Cape"));
/** game.ts: the 6-bone chain under Head. SpringBoneChain3D simulates every bone below the root. */
static const TCHAR* const GHairBones[] = { TEXT("ponytail_1"), TEXT("ponytail_2"), TEXT("ponytail_3"), TEXT("ponytail_4"), TEXT("ponytail_5"), TEXT("ponytail_6") };
static constexpr int32 GHairCount = UE_ARRAY_COUNT(GHairBones);

// --- animation: the game's AnimationPlayer crossfade ---------------------------------------

static void AdvanceLayer(FCharDynLayer& Layer, float Dt)
{
	const double Length = Layer.Clip ? Layer.Clip->GetPlayLength() : 0.0;
	Layer.Time += Dt;
	if (Length <= 0.0) return;
	if (Layer.bOnce) Layer.Time = FMath::Min(Layer.Time, Length);           // LoopOnce + clampWhenFinished
	else Layer.Time = Layer.Time - FMath::FloorToDouble(Layer.Time / Length) * Length; // LoopRepeat
}

void UCharDynAnimInstance::Play(UAnimSequence* Clip, float Fade, bool bOnce)
{
	if (Current.Clip == Clip)
	{
		const bool bFinished = Current.bOnce && Current.Time >= Clip->GetPlayLength();
		if (!bFinished && Current.bOnce == bOnce) return; // #playCurrent: same clip, same mode
		Outgoing.Reset();
		Current = { Clip, 0.0, bOnce, 1.f, 1.f };
		return;
	}
	// #playNext: every clip still contributing fades out from the weight it holds.
	float From = 0.f;
	double Time = 0.0;
	TArray<FCharDynLayer> Next;
	for (FCharDynLayer& Layer : Outgoing)
	{
		if (Layer.Clip == Clip)
		{
			From = Fade > 0.f ? Layer.Weight : 0.f;
			if (From > 0.f && !bOnce && !Layer.bOnce) Time = Layer.Time;
			continue;
		}
		if (Layer.Weight > 0.f) Next.Add({ Layer.Clip, Layer.Time, Layer.bOnce, Layer.Weight, Layer.Weight });
	}
	if (Current.Clip && Current.Weight > 0.f) Next.Add({ Current.Clip, Current.Time, Current.bOnce, Current.Weight, Current.Weight });
	const bool bFade = Fade > 0.f && Next.Num() > 0;
	Current = { Clip, Time, bOnce, bFade ? From : 1.f, 1.f };
	if (!bFade) Next.Reset();
	Outgoing = MoveTemp(Next);
	FadeElapsed = 0.f;
	FadeDuration = Fade;
	FadeInFrom = From;
}

void UCharDynAnimInstance::Advance(float Dt)
{
	// three: mixer.update advances every action and samples with the current weights ...
	AdvanceLayer(Current, Dt);
	for (FCharDynLayer& Layer : Outgoing) AdvanceLayer(Layer, Dt);
	Evaluated.Reset();
	Evaluated.Add(Current);
	Evaluated.Append(Outgoing);
	// ... then AnimationPlayer steps the fade (smoothstep) for the next tick.
	if (Outgoing.Num() > 0)
	{
		FadeElapsed = FMath::Min(FadeDuration, FadeElapsed + Dt);
		const float Linear = FadeDuration == 0.f ? 1.f : FadeElapsed / FadeDuration;
		const float Progress = Linear * Linear * (3.f - 2.f * Linear);
		for (FCharDynLayer& Layer : Outgoing) Layer.Weight = Layer.FadeFrom * (1.f - Progress);
		Current.Weight = FadeInFrom + (1.f - FadeInFrom) * Progress;
		if (Linear >= 1.f) Outgoing.Reset();
	}
}

void UCharDynAnimInstance::ResetSprings()
{
	// Initialize_AnyThread's reset (AnimNode_SpringBone.cpp:46): the next evaluation with no time
	// pending places each spring on its bone (:117-122).
	for (FAnimNode_SpringBone& Spring : GetProxyOnGameThread<FCharDynAnimProxy>().Springs) Spring.RemainingTime = 0.f;
}

FAnimInstanceProxy* UCharDynAnimInstance::CreateAnimInstanceProxy()
{
	return new FCharDynAnimProxy(this);
}

void FCharDynAnimProxy::Initialize(UAnimInstance* InAnimInstance)
{
	FAnimInstanceProxy::Initialize(InAnimInstance);
	// The ponytail nodes exist from initialization, as an AnimGraph's do, so the zero-length tick in
	// USkeletalMeshComponent::InitAnim (SkeletalMeshComponent.cpp:1213-1216) evaluates them with
	// RemainingTime 0 and places each spring on its bone (AnimNode_SpringBone.cpp:117-122). A node
	// first seen with time pending would start from the world origin.
	Springs.Reset();
	for (int32 B = 1; B < GHairCount; ++B) Springs.AddDefaulted_GetRef().SpringBone.BoneName = GHairBones[B];
}

void FCharDynAnimProxy::PreUpdate(UAnimInstance* InAnimInstance, float DeltaSeconds)
{
	FAnimInstanceProxy::PreUpdate(InAnimInstance, DeltaSeconds);
	const UCharDynAnimInstance* Instance = CastChecked<UCharDynAnimInstance>(InAnimInstance);
	Layers = Instance->Evaluated.Num() ? Instance->Evaluated : TArray<FCharDynLayer>{ Instance->Current };
	// The ponytail springs, stock defaults (AnimNode_SpringBone.cpp:16-38). An AnimGraph runs each
	// node's PreUpdate on the game thread, then UpdateInternal with the tick's delta
	// (AnimNode_SpringBone.cpp:55-64, 242-271); nothing else in the graph touches them.
	for (FAnimNode_SpringBone& Spring : Springs)
	{
		Spring.PreUpdate(InAnimInstance);
		Spring.UpdateInternal(FAnimationUpdateContext(this, DeltaSeconds));
	}
}

bool FCharDynAnimProxy::Evaluate(FPoseContext& Output)
{
	TArray<FCompactPose> Poses;
	TArray<FBlendedCurve> Curves;
	TArray<UE::Anim::FStackAttributeContainer> Attributes;
	TArray<float> Weights;
	float Total = 0.f;
	for (const FCharDynLayer& Layer : Layers)
		if (Layer.Clip && Layer.Weight > 0.f) Total += Layer.Weight;
	// No clip yet (InitAnim's zero-length tick): the ref pose, with the springs still on top, as an
	// AnimGraph evaluates them. That first evaluation has RemainingTime 0 and places each spring.
	if (Total <= 0.f) Output.ResetToRefPose();
	else
	{
		Poses.Reserve(Layers.Num());
		Curves.Reserve(Layers.Num());
		Attributes.Reserve(Layers.Num());
		for (const FCharDynLayer& Layer : Layers)
		{
			if (!Layer.Clip || Layer.Weight <= 0.f) continue;
			FCompactPose& Pose = Poses.AddDefaulted_GetRef();
			Pose.SetBoneContainer(&Output.Pose.GetBoneContainer());
			FBlendedCurve& Curve = Curves.AddDefaulted_GetRef();
			Curve.InitFrom(Output.Curve);
			UE::Anim::FStackAttributeContainer& Attribute = Attributes.AddDefaulted_GetRef();
			FAnimationPoseData Data(Pose, Curve, Attribute);
			Layer.Clip->GetAnimationPose(Data, FAnimExtractContext(Layer.Time, false, {}, !Layer.bOnce));
			Weights.Add(Layer.Weight / Total);
		}
		FAnimationPoseData Out(Output);
		FAnimationRuntime::BlendPosesTogether(Poses, Curves, Attributes, Weights, Out);
	}
	// The springs in component space, as FAnimNode_SkeletalControlBase applies a control at alpha 1
	// (AnimNode_SkeletalControlBase.cpp:191-197), then back to local space at the graph root.
	if (Springs.Num())
	{
		const FBoneContainer& Bones = Output.Pose.GetBoneContainer();
		FComponentSpacePoseContext CS(this);
		CS.Pose.InitPose(Output.Pose);
		TArray<FBoneTransform> Transforms;
		for (FAnimNode_SpringBone& Spring : Springs)
		{
			Spring.SpringBone.Initialize(Bones);
			if (!Spring.IsValidToEvaluate(GetSkeleton(), Bones))
			{
				UE_LOGF(LogTemp, Error, "TN_UE_CHARDYN spring bone %ls is not in the pose", *Spring.SpringBone.BoneName.ToString());
				continue;
			}
			Transforms.Reset();
			Spring.EvaluateSkeletalControl_AnyThread(CS, Transforms);
			if (Transforms.Num()) CS.Pose.LocalBlendCSBoneTransforms(Transforms, 1.f);
		}
		FCSPose<FCompactPose>::ConvertComponentPosesToLocalPoses(MoveTemp(CS.Pose), Output.Pose);
	}
	return true;
}

// --- helpers -------------------------------------------------------------------------------

static int32 CapeSection(USkeletalMesh* Mesh)
{
	const FSkeletalMeshLODModel& Lod = Mesh->GetImportedModel()->LODModels[0];
	const TArray<FSkeletalMaterial>& Materials = Mesh->GetMaterials();
	for (int32 S = 0; S < Lod.Sections.Num(); ++S)
	{
		const int32 M = Lod.Sections[S].MaterialIndex;
		if (Materials.IsValidIndex(M) && (Materials[M].MaterialSlotName == GCapeSlot || Materials[M].ImportedMaterialSlotName == GCapeSlot))
			return S;
	}
	return INDEX_NONE;
}

/** Grid id (row * 11 + column) of each cloth particle, read from UV0 of the matching render vertex. */
static bool GridIds(const FSkelMeshSection& Section, const TArray<FVector3f>& Particles, TArray<int32>& OutIds, FString& OutError)
{
	bool bFlipped = false;
	for (const FSoftSkinVertex& V : Section.SoftVertices)
		if (V.UVs[0].Y < -0.25f) bFlipped = true; // an importer that writes 1 - v
	OutIds.Init(INDEX_NONE, Particles.Num());
	TSet<int32> Seen;
	for (int32 P = 0; P < Particles.Num(); ++P)
	{
		float Best = TNumericLimits<float>::Max();
		int32 BestV = INDEX_NONE;
		for (int32 V = 0; V < Section.SoftVertices.Num(); ++V)
		{
			const float D = FVector3f::DistSquared(Section.SoftVertices[V].Position, Particles[P]);
			if (D < Best) { Best = D; BestV = V; }
		}
		if (BestV == INDEX_NONE || Best > 1e-4f) { OutError = FString::Printf(TEXT("particle %d has no render vertex"), P); return false; }
		const FVector2f UV = Section.SoftVertices[BestV].UVs[0];
		const int32 Col = FMath::RoundToInt(UV.X);
		const int32 Row = FMath::RoundToInt(bFlipped ? 1.f - UV.Y : UV.Y);
		const int32 Id = Row * GCols + Col;
		if (Col < 0 || Col >= GCols || Row < 0 || Row >= GRows || Seen.Contains(Id)) { OutError = FString::Printf(TEXT("particle %d has UV (%f, %f)"), P, UV.X, UV.Y); return false; }
		Seen.Add(Id);
		OutIds[P] = Id;
	}
	if (Seen.Num() != GCols * GRows) { OutError = FString::Printf(TEXT("%d cloth particles, the grid has %d"), Seen.Num(), GCols * GRows); return false; }
	return true;
}

static UClothingAssetCommon* CapeAsset(USkeletalMesh* Mesh)
{
	for (UClothingAssetBase* Asset : Mesh->GetMeshClothingAssets())
		if (UClothingAssetCommon* Common = Cast<UClothingAssetCommon>(Asset)) return Common;
	return nullptr;
}

static FString JsonString(const TSharedRef<FJsonObject>& Object)
{
	FString Out;
	TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
	FJsonSerializer::Serialize(Object, Writer);
	return Out;
}

static TArray<TSharedPtr<FJsonValue>> Vec(const FVector& V)
{
	return { MakeShared<FJsonValueNumber>(V.X), MakeShared<FJsonValueNumber>(V.Y), MakeShared<FJsonValueNumber>(V.Z) };
}

// --- build ---------------------------------------------------------------------------------

FString UCharDynProbeLibrary::CreateCapeCloth(USkeletalMesh* Mesh, UPhysicsAsset* Body, float MaxDistance)
{
	if (!Mesh || !Body) return TEXT("ERROR mesh or physics asset is null");
	FAssetCompilingManager::Get().FinishAllCompilation();
	const int32 Section = CapeSection(Mesh);
	if (Section == INDEX_NONE) return TEXT("ERROR no section uses the M_Cape material slot");
	if (CapeAsset(Mesh)) return TEXT("ERROR the mesh already has clothing data");

	// SkeletalMeshEditor.cpp OnCreateClothingAssetMenuItemClicked: the same factory call.
	FSkeletalMeshClothBuildParams Params;
	Params.AssetName = TEXT("Cape");
	Params.LodIndex = 0;
	Params.SourceSection = Section;
	Params.bRemoveFromMesh = false;
	Params.PhysicsAsset = Body;
	Mesh->Modify();
	FClothingSystemEditorInterfaceModule& ClothingEditor = FModuleManager::LoadModuleChecked<FClothingSystemEditorInterfaceModule>("ClothingSystemEditorInterface");
	UClothingAssetCommon* Asset = Cast<UClothingAssetCommon>(ClothingEditor.GetClothingAssetFactory()->CreateFromSkeletalMesh(Mesh, Params));
	if (!Asset) return TEXT("ERROR CreateFromSkeletalMesh returned null");
	Mesh->AddClothingAsset(Asset);

	// Paint the max distance mask: 0 on the pinned top row, MaxDistance below it.
	FClothLODDataCommon& Lod = Asset->LodData[0];
	TArray<int32> Ids;
	FString Error;
	if (!GridIds(Mesh->GetImportedModel()->LODModels[0].Sections[Section], Lod.PhysicalMeshData.Vertices, Ids, Error)) return TEXT("ERROR ") + Error;
	FPointWeightMap* Mask = Lod.PointWeightMaps.FindByPredicate([](const FPointWeightMap& M) { return M.CurrentTarget == (uint8)EWeightMapTargetCommon::MaxDistance; });
	if (!Mask) return TEXT("ERROR the cloth LOD has no max distance mask");
	int32 Pinned = 0;
	for (int32 P = 0; P < Ids.Num(); ++P)
	{
		const bool bTop = Ids[P] < GCols;
		Mask->Values[P] = bTop ? 0.f : MaxDistance;
		Pinned += bTop;
	}
	Asset->ApplyParameterMasks();
	Asset->PostUpdateAllAssets(); // adds the stock Chaos configs (AddClothConfigs is private)
	if (!FSkeletalMeshClothingSystemUtilities::AssignClothingToSection(Mesh, Asset, 0, Section, 0, &Error)) return TEXT("ERROR AssignClothingToSection: ") + Error;
	FAssetCompilingManager::Get().FinishAllCompilation();

	TSharedRef<FJsonObject> Report = MakeShared<FJsonObject>();
	Report->SetNumberField(TEXT("section"), Section);
	Report->SetNumberField(TEXT("particles"), Ids.Num());
	Report->SetNumberField(TEXT("pinned"), Pinned);
	Report->SetNumberField(TEXT("maxDistanceCm"), MaxDistance);
	return JsonString(Report);
}

FString UCharDynProbeLibrary::DescribeMesh(USkeletalMesh* Mesh, UPhysicsAsset* Body)
{
	if (!Mesh) return TEXT("ERROR mesh is null");
	FAssetCompilingManager::Get().FinishAllCompilation();
	TSharedRef<FJsonObject> Report = MakeShared<FJsonObject>();
	const FReferenceSkeleton& Ref = Mesh->GetRefSkeleton();
	TSharedRef<FJsonObject> Bones = MakeShared<FJsonObject>();
	for (int32 B = 0; B < Ref.GetNum(); ++B)
		Bones->SetArrayField(Ref.GetBoneName(B).ToString(), Vec(FAnimationRuntime::GetComponentSpaceTransformRefPose(Ref, B).GetLocation()));
	Report->SetObjectField(TEXT("refBones"), Bones);

	if (UClothingAssetCommon* Asset = CapeAsset(Mesh))
	{
		TSharedRef<FJsonObject> Cloth = MakeShared<FJsonObject>();
		Cloth->SetStringField(TEXT("asset"), Asset->GetPathName());
		Cloth->SetStringField(TEXT("referenceBone"), Ref.IsValidIndex(Asset->ReferenceBoneIndex) ? Ref.GetBoneName(Asset->ReferenceBoneIndex).ToString() : TEXT("?"));
		Cloth->SetStringField(TEXT("physicsAsset"), Asset->PhysicsAsset ? Asset->PhysicsAsset->GetPathName() : TEXT("none"));
		Cloth->SetNumberField(TEXT("particles"), Asset->LodData[0].PhysicalMeshData.Vertices.Num());
		TSharedRef<FJsonObject> Configs = MakeShared<FJsonObject>();
		for (const TPair<FName, TObjectPtr<UClothConfigBase>>& Pair : Asset->ClothConfigs)
		{
			TSharedRef<FJsonObject> Values = MakeShared<FJsonObject>();
			if (Pair.Value) FJsonObjectConverter::UStructToJsonObject(Pair.Value->GetClass(), Pair.Value.Get(), Values, 0, CPF_Transient | CPF_Deprecated);
			Configs->SetObjectField(Pair.Key.ToString(), Values);
		}
		Cloth->SetObjectField(TEXT("configs"), Configs);
		Report->SetObjectField(TEXT("cloth"), Cloth);
	}
	if (Body)
	{
		TArray<TSharedPtr<FJsonValue>> Bodies;
		for (const USkeletalBodySetup* Setup : Body->SkeletalBodySetups)
		{
			if (!Setup) continue;
			TSharedRef<FJsonObject> B = MakeShared<FJsonObject>();
			B->SetStringField(TEXT("bone"), Setup->BoneName.ToString());
			TArray<TSharedPtr<FJsonValue>> Shapes;
			for (const FKSphylElem& E : Setup->AggGeom.SphylElems)
				Shapes.Add(MakeShared<FJsonValueString>(FString::Printf(TEXT("capsule r=%.2f length=%.2f"), E.Radius, E.Length)));
			for (const FKSphereElem& E : Setup->AggGeom.SphereElems)
				Shapes.Add(MakeShared<FJsonValueString>(FString::Printf(TEXT("sphere r=%.2f"), E.Radius)));
			for (const FKBoxElem& E : Setup->AggGeom.BoxElems)
				Shapes.Add(MakeShared<FJsonValueString>(FString::Printf(TEXT("box %.2fx%.2fx%.2f"), E.X, E.Y, E.Z)));
			for (const FKTaperedCapsuleElem& E : Setup->AggGeom.TaperedCapsuleElems)
				Shapes.Add(MakeShared<FJsonValueString>(FString::Printf(TEXT("tapered r0=%.2f r1=%.2f length=%.2f"), E.Radius0, E.Radius1, E.Length)));
			if (Setup->AggGeom.ConvexElems.Num()) Shapes.Add(MakeShared<FJsonValueString>(FString::Printf(TEXT("convex x%d"), Setup->AggGeom.ConvexElems.Num())));
			B->SetArrayField(TEXT("shapes"), Shapes);
			Bodies.Add(MakeShared<FJsonValueObject>(B));
		}
		Report->SetArrayField(TEXT("bodies"), Bodies);
	}
	return JsonString(Report);
}

// --- run -----------------------------------------------------------------------------------

/** World ends of a physics-asset capsule on its posed bone (ChaosClothingSimulationCollider.cpp:590-597). */
static void CapsuleEnds(const USkeletalMeshComponent* Comp, FName Bone, const FKSphylElem& E, FVector& OutA, FVector& OutB)
{
	FTransform BoneT = Comp->GetBoneTransform(Comp->GetBoneIndex(Bone));
	BoneT.RemoveScaling();
	const FVector Half = E.Rotation.RotateVector(FVector::UpVector) * (E.Length / 2.f);
	OutA = BoneT.TransformPosition(E.Center - Half);
	OutB = BoneT.TransformPosition(E.Center + Half);
}


FString UCharDynProbeLibrary::RunDrive(USkeletalMesh* Mesh, const TArray<UAnimSequence*>& Clips, const TArray<FString>& ClipNames, const FString& DrivePath, const FString& OutPath)
{
	if (!Mesh || Clips.Num() != ClipNames.Num()) return TEXT("ERROR bad arguments");
	FAssetCompilingManager::Get().FinishAllCompilation();
	TMap<FString, UAnimSequence*> ByName;
	for (int32 I = 0; I < Clips.Num(); ++I) ByName.Add(ClipNames[I], Clips[I]);

	FString Text;
	if (!FFileHelper::LoadFileToString(Text, *DrivePath)) return TEXT("ERROR cannot read ") + DrivePath;
	TSharedPtr<FJsonObject> Drive;
	if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Drive) || !Drive) return TEXT("ERROR drive.json does not parse");
	const float Step = (float)Drive->GetNumberField(TEXT("step"));
	const TArray<TSharedPtr<FJsonValue>>& Ticks = Drive->GetArrayField(TEXT("ticks"));
	UAnimSequence* const* Initial = ByName.Find(Drive->GetStringField(TEXT("initialClip")));
	if (!Initial) return TEXT("ERROR initial clip missing");

	UClothingAssetCommon* Asset = CapeAsset(Mesh);
	const int32 Section = CapeSection(Mesh);
	if (!Asset || Section == INDEX_NONE) return TEXT("ERROR the mesh has no cape cloth");
	TArray<int32> Ids;
	FString Error;
	if (!GridIds(Mesh->GetImportedModel()->LODModels[0].Sections[Section], Asset->LodData[0].PhysicalMeshData.Vertices, Ids, Error)) return TEXT("ERROR ") + Error;
	const int32 AssetIndex = Mesh->GetClothingAssetIndex(Asset->GetAssetGuid());

	// A fresh game world, ticked by hand at the fixed step.
	// CreateWorld's defaults turn physics simulation off, and with it the cloth actors
	// (SkeletalMeshComponentPhysics.cpp RecreateClothingActors); a played level simulates.
	const UWorld::InitializationValues Values = UWorld::InitializationValues().CreatePhysicsScene(true).ShouldSimulatePhysics(true)
		.EnableTraceCollision(true).CreateNavigation(false).CreateAISystem(false);
	UWorld* World = UWorld::CreateWorld(EWorldType::Game, false, TEXT("CharDynWorld"), nullptr, true, ERHIFeatureLevel::Num, &Values);
	FWorldContext& Context = GEngine->CreateNewWorldContext(EWorldType::Game);
	Context.SetCurrentWorld(World);
	// No game instance or game mode: begin play the way AWorldSettings does once a match starts.
	World->InitializeActorsForPlay(FURL());
	World->GetWorldSettings()->NotifyBeginPlay();
	FString Result;
	ASkeletalMeshActor* Actor = World->SpawnActor<ASkeletalMeshActor>(FVector::ZeroVector, FRotator::ZeroRotator);
	USkeletalMeshComponent* Comp = Actor ? Actor->GetSkeletalMeshComponent() : nullptr;
	if (!Comp) Result = TEXT("ERROR spawn failed");
	TArray<FString> Lines;
	TMap<FName, FKAggregateGeom> SavedGeom;
	TArray<TSharedPtr<FJsonValue>> ShrinkReport;
	if (Result.IsEmpty())
	{
		Comp->SetMobility(EComponentMobility::Movable);
		// Harness settings, not cloth parameters: nothing renders offscreen, so the pose must
		// refresh without a render, and the game thread must wait for the cloth to read it.
		Comp->VisibilityBasedAnimTickOption = EVisibilityBasedAnimTickOption::AlwaysTickPoseAndRefreshBones;
		Comp->bWaitForParallelClothTask = true;
		Comp->SetSkeletalMesh(Mesh);
		Comp->SetAnimationMode(EAnimationMode::AnimationBlueprint);
		Comp->SetAnimInstanceClass(UCharDynAnimInstance::StaticClass());
		UCharDynAnimInstance* Anim = Cast<UCharDynAnimInstance>(Comp->GetAnimInstance());
		const int32 Spine = Comp->GetBoneIndex(TEXT("spine_03"));
		const int32 Pelvis = Comp->GetBoneIndex(TEXT("pelvis"));
		const int32 Neck = Comp->GetBoneIndex(TEXT("neck_01"));
		const int32 Head = Comp->GetBoneIndex(TEXT("Head"));
		TArray<int32> Hair;
		for (const TCHAR* Name : GHairBones) Hair.Add(Comp->GetBoneIndex(Name));
		// game.ts hairBoneNames: the capsules the ponytail falls onto (Unreal generates no neck_01 body).
		const TSet<FName> HairColliderBones = { TEXT("Head"), TEXT("neck_01"), TEXT("spine_03"), TEXT("spine_02"), TEXT("upperarm_l"), TEXT("upperarm_r") };
		if (!Anim || Spine == INDEX_NONE || Pelvis == INDEX_NONE || Neck == INDEX_NONE || Head == INDEX_NONE || Hair.Contains(INDEX_NONE)) Result = TEXT("ERROR anim instance or bones missing");
		else
		{
			auto Sample = [&](bool bCloth) -> FString
			{
				TSharedRef<FJsonObject> S = MakeShared<FJsonObject>();
				FTransform SpineT = Comp->GetBoneTransform(Spine);
				SpineT.RemoveScaling();
				TArray<TSharedPtr<FJsonValue>> Frame = Vec(SpineT.GetLocation());
				Frame.Append(Vec(SpineT.GetUnitAxis(EAxis::X)));
				Frame.Append(Vec(SpineT.GetUnitAxis(EAxis::Y)));
				Frame.Append(Vec(SpineT.GetUnitAxis(EAxis::Z)));
				S->SetArrayField(TEXT("spine"), Frame);
				S->SetArrayField(TEXT("pelvis"), Vec(Comp->GetBoneTransform(Pelvis).GetLocation()));
				S->SetArrayField(TEXT("neck"), Vec(Comp->GetBoneTransform(Neck).GetLocation()));
				S->SetArrayField(TEXT("head"), Vec(Comp->GetBoneTransform(Head).GetLocation()));
				// The ponytail: the Head frame (origin, unit axes), the 6 bones (world cm), and the stock
				// (unshrunk) capsules of the bones it falls onto, as game.ts measures them (a xyz, b xyz, r).
				FTransform HeadT = Comp->GetBoneTransform(Head);
				HeadT.RemoveScaling();
				TArray<TSharedPtr<FJsonValue>> HeadFrame = Vec(HeadT.GetLocation());
				HeadFrame.Append(Vec(HeadT.GetUnitAxis(EAxis::X)));
				HeadFrame.Append(Vec(HeadT.GetUnitAxis(EAxis::Y)));
				HeadFrame.Append(Vec(HeadT.GetUnitAxis(EAxis::Z)));
				S->SetArrayField(TEXT("headFrame"), HeadFrame);
				TArray<TSharedPtr<FJsonValue>> HairPoints;
				for (const int32 B : Hair) HairPoints.Append(Vec(Comp->GetBoneTransform(B).GetLocation()));
				S->SetArrayField(TEXT("hair"), HairPoints);
				TArray<TSharedPtr<FJsonValue>> HairCaps;
				for (const TPair<FName, FKAggregateGeom>& Pair : SavedGeom)
					if (HairColliderBones.Contains(Pair.Key))
						for (const FKSphylElem& E : Pair.Value.SphylElems)
						{
							FVector A, B;
							CapsuleEnds(Comp, Pair.Key, E, A, B);
							HairCaps.Append(Vec(A));
							HairCaps.Append(Vec(B));
							HairCaps.Add(MakeShared<FJsonValueNumber>(E.Radius));
						}
				S->SetArrayField(TEXT("hairCapsules"), HairCaps);
				// The capsules the cloth collides with, posed: a xyz, b xyz, radius (world cm).
				TArray<TSharedPtr<FJsonValue>> Caps;
				if (Asset->PhysicsAsset)
					for (const USkeletalBodySetup* Setup : Asset->PhysicsAsset->SkeletalBodySetups)
						if (Setup)
							for (const FKSphylElem& E : Setup->AggGeom.SphylElems)
							{
								FVector A, B;
								CapsuleEnds(Comp, Setup->BoneName, E, A, B);
								Caps.Append(Vec(A));
								Caps.Append(Vec(B));
								Caps.Add(MakeShared<FJsonValueNumber>(E.Radius));
							}
				S->SetArrayField(TEXT("capsules"), Caps);
				if (bCloth)
				{
					const FClothSimulData* Data = Comp->GetCurrentClothingData_GameThread().Find(AssetIndex);
					if (!Data || Data->Positions.Num() != Ids.Num())
					{
						S->SetNumberField(TEXT("missingCloth"), Data ? Data->Positions.Num() : -1);
						return JsonString(S);
					}
					TArray<FVector> Grid;
					Grid.SetNum(Ids.Num());
					for (int32 P = 0; P < Ids.Num(); ++P) Grid[Ids[P]] = Data->Transform.TransformPosition((FVector)Data->Positions[P]);
					TArray<TSharedPtr<FJsonValue>> Flat;
					for (const FVector& G : Grid) Flat.Append(Vec(G));
					S->SetArrayField(TEXT("cloth"), Flat);
				}
				return JsonString(S);
			};
			// t = 0: Idle_Loop at time 0, the pose game.ts places the cape on.
			Anim->Play(*Initial, 0.f, false);
			// A zero-length tick poses the mesh and registers the cloth tick, which the component
			// only registers from inside its own tick (UpdateClothTickRegisteredState); a zero dt
			// simulates nothing (UpdateClothStateAndSimulate returns on DeltaTime == 0).
			// A tick function runs once per GFrameCounter (TickTaskManager.cpp), and every hand
			// tick here runs inside one editor frame, so each hand tick is its own frame.
			++GFrameCounter;
			World->Tick(LEVELTICK_All, 0.f);
			// The world's zero-length tick still advances 0.5 ms (AWorldSettings::FixupDeltaSeconds clamps
			// to MinUndilatedFrameTime), so the springs are reset here and placed on the Idle_Loop t = 0
			// pose by this zero-length evaluation, as InitAnim's zero tick places them when the graph's
			// entry pose is Idle_Loop (SkeletalMeshComponent.cpp:1213-1216; the game builds its
			// SpringBoneChain3D on that pose). Less than one 1/120 s step is pending before tick 1.
			Anim->ResetSprings();
			Comp->TickAnimation(0.f, false);
			Comp->RefreshBoneTransforms();
			// Named override, applied in both engines (game.ts: measureBodyCapsules(capeSkin, 16, restWorld,
			// COLLIDER_THICKNESS)): no capsule may reach a rest cape vertex. The generated physics asset
			// fits spine_03 to the chest and shoulders (r 20 cm), and the cape hangs 14 cm behind that bone,
			// so stock collision and the pinned row fight from the first step. Each capsule's radius becomes
			// min(radius, distance to the nearest rest cape vertex - 1 cm), on the Idle_Loop t = 0 pose the
			// cape is placed on; a capsule left under 0.1 cm is dropped. Restored after the run.
			UPhysicsAsset* Body = Asset->PhysicsAsset;
			check(Body); // CreateCapeCloth sets it
			for (const USkeletalBodySetup* Setup : Body->SkeletalBodySetups)
				if (Setup) SavedGeom.Add(Setup->BoneName, Setup->AggGeom);
			{
				const FSkelMeshSection& CapeSec = Mesh->GetImportedModel()->LODModels[0].Sections[Section];
				FTransform SpineNow = Comp->GetBoneTransform(Spine);
				const FTransform Skin = FAnimationRuntime::GetComponentSpaceTransformRefPose(Mesh->GetRefSkeleton(), Spine).Inverse() * SpineNow;
				TArray<FVector> Rest;
				for (const FSoftSkinVertex& V : CapeSec.SoftVertices) Rest.Add(Skin.TransformPosition((FVector)V.Position));
				TArray<TSharedPtr<FJsonValue>> Report;
				for (USkeletalBodySetup* Setup : Body->SkeletalBodySetups)
				{
					if (!Setup) continue;
					for (int32 K = Setup->AggGeom.SphylElems.Num() - 1; K >= 0; --K)
					{
						FKSphylElem& E = Setup->AggGeom.SphylElems[K];
						FVector A, B;
						CapsuleEnds(Comp, Setup->BoneName, E, A, B);
						float Clear = TNumericLimits<float>::Max();
						int32 Inside = 0;
						for (const FVector& P : Rest)
						{
							const float D = FMath::PointDistToSegment(P, A, B);
							Clear = FMath::Min(Clear, D);
							Inside += D < E.Radius;
						}
						const float Used = FMath::Min(E.Radius, Clear - 1.f);
						TSharedRef<FJsonObject> Row = MakeShared<FJsonObject>();
						Row->SetStringField(TEXT("bone"), Setup->BoneName.ToString());
						Row->SetNumberField(TEXT("radiusCm"), E.Radius);
						Row->SetNumberField(TEXT("restClearanceCm"), Clear);
						Row->SetNumberField(TEXT("restVerticesInside"), Inside);
						Row->SetNumberField(TEXT("radiusUsedCm"), Used > 0.1f ? Used : 0.f);
						Report.Add(MakeShared<FJsonValueObject>(Row));
						if (Used > 0.1f) E.Radius = Used;
						else Setup->AggGeom.SphylElems.RemoveAt(K);
					}
				}
				ShrinkReport = Report;
			}
			// The cloth collider copies the physics asset when the clothing actors are made.
			Comp->RecreateClothingActors();
			++GFrameCounter;
			World->Tick(LEVELTICK_All, 0.f);
			const FString InitialSample = Sample(false);
			Comp->ForceClothNextUpdateTeleportAndReset();
			for (int32 T = 0; T < Ticks.Num() && Result.IsEmpty(); ++T)
			{
				const TSharedPtr<FJsonObject>& Tick = Ticks[T]->AsObject();
				const TArray<TSharedPtr<FJsonValue>>& L = Tick->GetArrayField(TEXT("location"));
				Actor->SetActorLocationAndRotation(FVector(L[0]->AsNumber(), L[1]->AsNumber(), L[2]->AsNumber()), FRotator(0.0, Tick->GetNumberField(TEXT("yaw")), 0.0));
				for (const TSharedPtr<FJsonValue>& PlayValue : Tick->GetArrayField(TEXT("plays")))
				{
					const TSharedPtr<FJsonObject>& Play = PlayValue->AsObject();
					UAnimSequence* const* Clip = ByName.Find(Play->GetStringField(TEXT("clip")));
					if (!Clip) { Result = TEXT("ERROR clip missing: ") + Play->GetStringField(TEXT("clip")); break; }
					Anim->Play(*Clip, (float)Play->GetNumberField(TEXT("fade")), Play->GetBoolField(TEXT("once")));
				}
				Anim->Advance(Step);
				++GFrameCounter;
				World->Tick(LEVELTICK_All, Step);
				FString Line = Sample(true);
				if (T == 0)
				{
					UE_LOGF(LogTemp, Display, "TN_UE_CHARDYN diag tick1: paused %d time %f actorTickReg %d compTickReg %d compTickEnabled %d animTime %f evaluated %d gameWorld %d actorTickEnabled %d",
						World->IsPaused(), World->GetTimeSeconds(), Actor->PrimaryActorTick.IsTickFunctionRegistered(), Comp->PrimaryComponentTick.IsTickFunctionRegistered(),
						Comp->PrimaryComponentTick.IsTickFunctionEnabled(), Anim->Current.Time, Anim->Evaluated.Num(), World->IsGameWorld(), Actor->IsActorTickEnabled());
				}
				if (Line.IsEmpty())
				{
					const TMap<int32, FClothSimulData>& All = Comp->GetCurrentClothingData_GameThread();
					TArray<int32> Keys;
					All.GetKeys(Keys);
					Result = FString::Printf(TEXT("ERROR no cloth data at tick %d: asset index %d, data keys [%s], positions %d, registered %d, begun play %d, simulation %d, mesh has cloth for LOD0 %d"), T + 1, AssetIndex,
						*FString::JoinBy(Keys, TEXT(","), [](int32 K) { return FString::FromInt(K); }), All.Num() ? All.CreateConstIterator().Value().Positions.Num() : -1,
						Comp->IsRegistered(), Actor->HasActorBegunPlay(), Comp->GetClothingSimulation() != nullptr, Mesh->HasActiveClothingAssetsForLOD(0));
				}
				Lines.Add(Line);
			}
			if (Result.IsEmpty())
			{
				TSharedRef<FJsonObject> Ue = MakeShared<FJsonObject>();
				Ue->SetNumberField(TEXT("teleportDistanceThreshold"), Comp->GetTeleportDistanceThreshold());
				Ue->SetNumberField(TEXT("teleportRotationThreshold"), Comp->GetTeleportRotationThreshold());
				Ue->SetBoolField(TEXT("resetAfterTeleport"), Comp->bResetAfterTeleport);
				Ue->SetNumberField(TEXT("gravityZ"), World->GetGravityZ());
				Ue->SetArrayField(TEXT("restClearance"), ShrinkReport);
				const FString Out = TEXT("{\"ue\":") + JsonString(Ue) + TEXT(",\"initial\":") + InitialSample + TEXT(",\"ticks\":[\n") + FString::Join(Lines, TEXT(",\n")) + TEXT("]}\n");
				if (!FFileHelper::SaveStringToFile(Out, *OutPath)) Result = TEXT("ERROR cannot write ") + OutPath;
			}
		}
	}
	if (UPhysicsAsset* Body = Asset->PhysicsAsset)
		for (USkeletalBodySetup* Setup : Body->SkeletalBodySetups)
			if (const FKAggregateGeom* Geom = Setup ? SavedGeom.Find(Setup->BoneName) : nullptr) Setup->AggGeom = *Geom;
	World->DestroyWorld(false);
	GEngine->DestroyWorldContext(World);
	return Result;
}
