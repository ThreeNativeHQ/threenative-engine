// PRD-910 Unreal reference. Python cannot create cloth data from a section or read simulated
// cloth positions, so these two calls are C++; build_scene.py drives everything else.
#pragma once

#include "CoreMinimal.h"
#include "Animation/AnimInstance.h"
#include "Animation/AnimInstanceProxy.h"
#include "BoneControllers/AnimNode_AnimDynamics.h"
#include "BoneControllers/AnimNode_SpringBone.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "CharDynProbe.generated.h"

class UAnimSequence;
class UPhysicsAsset;
class USkeletalMesh;

/** One clip in the crossfade stack, three.js AnimationAction semantics (time, loop, weight). */
struct FCharDynLayer
{
	TObjectPtr<UAnimSequence> Clip = nullptr;
	double Time = 0.0;
	bool bOnce = false;
	float Weight = 1.f;
	float FadeFrom = 1.f; // weight an outgoing layer fades from
};

/** Stock FAnimNode_AnimDynamics, with the validity check an AnimGraph makes opened up. */
struct FCharDynAnimDynamics : public FAnimNode_AnimDynamics
{
	using FAnimNode_AnimDynamics::IsValidToEvaluate;
};

/**
 * One AnimDynamics chain over ponytail_1..6, evaluated beside the SpringBone chain on the same
 * animated pose. Its output is recorded, not applied, so the cape and the springs do not change.
 */
struct FCharDynDynamicsArm
{
	FString Name;
	FCharDynAnimDynamics Node;
	/** ponytail_1..6 as the node wrote them on the last evaluation (component space, cm). */
	TArray<FVector> Bones;
};

/**
 * One more FAnimNode_SpringBone chain over ponytail_2..6 with named option overrides, on its own copy
 * of the animated pose. Like the AnimDynamics arms, its output is recorded, not applied.
 */
struct FCharDynSpringArm
{
	FString Name;
	TArray<FAnimNode_SpringBone> Springs;
	/** ponytail_1..6 as the chain wrote them on the last evaluation (component space, cm). */
	TArray<FVector> Bones;
};

/**
 * Plays clips the way the game's AnimationPlayer does (packages/core/src/animation.ts play/update):
 * a play fades every contributing clip out and the new one in over `fade` seconds with a
 * smoothstep weight; a clip already playing in the same mode keeps playing; each tick advances
 * every clip, samples the pose with the weights from before this tick's fade step, then steps
 * the fade.
 */
UCLASS(Transient)
class UCharDynAnimInstance : public UAnimInstance
{
	GENERATED_BODY()

public:
	void Play(UAnimSequence* Clip, float Fade, bool bOnce);
	void Advance(float DeltaSeconds);
	/** Puts the ponytail springs and AnimDynamics arms back in their just-initialized state (no time pending). */
	void ResetSprings(float PerturbCm = 0.f);
	/** What a teleporting SetActorLocation (ETeleportType::TeleportPhysics) does to an AnimGraph's
	 * AnimDynamics nodes (SkeletalMeshComponent.cpp:5350-5354, AnimInstanceProxy.cpp:3280-3289). */
	void TeleportDynamics();
	const TArray<FCharDynDynamicsArm>& DynamicsArms();
	const TArray<FCharDynSpringArm>& SpringArms();
	FIntPoint UpdatesAndEvaluations();

	TArray<FCharDynLayer> Outgoing;
	FCharDynLayer Current;
	float FadeElapsed = 0.f;
	float FadeDuration = 0.f;
	float FadeInFrom = 0.f;
	/** Clips and weights the next evaluation samples. */
	TArray<FCharDynLayer> Evaluated;

protected:
	virtual FAnimInstanceProxy* CreateAnimInstanceProxy() override;
};

struct FCharDynAnimProxy : public FAnimInstanceProxy
{
	FCharDynAnimProxy() = default;
	explicit FCharDynAnimProxy(UAnimInstance* Instance) : FAnimInstanceProxy(Instance) {}
	virtual void Initialize(UAnimInstance* InAnimInstance) override;
	virtual void PreUpdate(UAnimInstance* InAnimInstance, float DeltaSeconds) override;
	virtual bool Evaluate(FPoseContext& Output) override;

	TArray<FCharDynLayer> Layers;
	/**
	 * The ponytail: one stock FAnimNode_SpringBone per simulated bone (ponytail_2 .. ponytail_6),
	 * parent first, each fed the pose the previous one wrote, as a chain of SpringBone nodes in an
	 * AnimGraph. ponytail_1 rides Head, as the root of the game's SpringBoneChain3D does.
	 */
	TArray<FAnimNode_SpringBone> Springs;
	/** PRD-912 AC-3: FAnimNode_AnimDynamics in chain mode, stock and with named overrides. */
	TArray<FCharDynDynamicsArm> Dynamics;
	/** Recorded SpringBone arms with option overrides (PRD-912 AC-3 `hairSpringBoneRotate`). */
	TArray<FCharDynSpringArm> SpringArms;
	/** Perturbation run: the next evaluation moves ponytail_2..6 by PerturbCm along a fixed pseudo-random unit vector each. */
	float PerturbCm = 0.f;
	bool bPerturbNext = false;
	/** Initialize_AnyThread the arms on the next evaluation (graph init, or ResetSprings). */
	bool bInitDynamics = true;
	/** Harness check: updates and evaluations so far (each tick must add one of each). */
	int32 Updates = 0;
	int32 Evaluations = 0;
};

UCLASS()
class UCharDynProbeLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	/**
	 * Makes the section whose material slot is `M_Cape` a Chaos Cloth asset, the editor's
	 * "Create Clothing Data from Section" + "Apply Clothing Data" path with stock configs. The
	 * max distance mask is 0 on the top row (grid row 0, read from UV0.y) and `MaxDistance`
	 * elsewhere. `Body` is the physics asset used for collision. Returns a JSON report or an
	 * "ERROR ..." string.
	 */
	UFUNCTION(BlueprintCallable, Category = "CharDyn")
	static FString CreateCapeCloth(USkeletalMesh* Mesh, UPhysicsAsset* Body, float MaxDistance);

	/** Reference-pose component-space bone positions and the cloth asset's configs, as JSON. */
	UFUNCTION(BlueprintCallable, Category = "CharDyn")
	static FString DescribeMesh(USkeletalMesh* Mesh, UPhysicsAsset* Body);

	/**
	 * Spawns the mesh in a fresh game world, replays drive.json at its fixed step (actor
	 * transform and clip plays per tick), and writes the simulated cape (grid order, world cm),
	 * the spine_03 frame and the torso capsule ends per tick to `OutPath`. Returns "" or an
	 * "ERROR ..." string. `PerturbCm` > 0 is the perturbation run: every free cloth particle starts
	 * PerturbCm along its own fixed unit vector (FRandomStream(1000 + particle).VRand()), and
	 * ponytail_2..6 start PerturbCm along theirs (FRandomStream(90000 + bone index).VRand()).
	 */
	UFUNCTION(BlueprintCallable, Category = "CharDyn")
	static FString RunDrive(USkeletalMesh* Mesh, const TArray<UAnimSequence*>& Clips, const TArray<FString>& ClipNames,
		const FString& DrivePath, const FString& OutPath, float PerturbCm);
};
