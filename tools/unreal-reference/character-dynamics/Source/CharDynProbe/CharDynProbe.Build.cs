using UnrealBuildTool;

public class CharDynProbe : ModuleRules
{
	public CharDynProbe(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine" });
		PrivateDependencyModuleNames.AddRange(new string[] {
			"UnrealEd", "Json", "JsonUtilities",
			"ClothingSystemRuntimeCommon", "ClothingSystemRuntimeInterface", "ClothingSystemEditorInterface",
			"SkeletalMeshEditor", "PhysicsCore", "AnimGraphRuntime",
		});
	}
}
