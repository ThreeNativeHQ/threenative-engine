using UnrealBuildTool;

public class CharacterDynamicsReferenceEditorTarget : TargetRules
{
	public CharacterDynamicsReferenceEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.V7;
		IncludeOrderVersion = EngineIncludeOrderVersion.Unreal5_8;
		ExtraModuleNames.Add("CharDynProbe");
	}
}
