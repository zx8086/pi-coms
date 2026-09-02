// extensions/identityNote.ts

// The agent has no reliable sense of its own coms name and will guess it from
// context (often its sibling monitor-<name>) when asked to identify itself.
// The extension knows the registered name exactly, so it hands it over as a
// fact the model can read instead of recall (SIO-1600). Keep this to the
// identity fact only; ping formats and listing conventions live elsewhere.
export function buildIdentityNote(name: string): string {
	return (
		`[coms-net identity] Your coms-net peer name is "${name}". ` +
		`When asked to identify yourself, use exactly this name. ` +
		`Your AWS account id, if needed, comes from sts get-caller-identity, not memory.`
	);
}
