// A run spec carries no secret. These patterns catch the shapes a secret takes
// when someone pastes one into a field meant to hold a reference, so the run is
// refused instead of the value being written into a generated file.
//
// This is a net, not the boundary. The boundary is that `pix` never asks for a
// credential value: the only credential input it accepts is a command Pi runs.

const SECRET_VALUE_PATTERNS = [
  // Provider key prefixes: sk-..., pk-..., rk-...
  /(?:^|[^A-Za-z0-9])(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/i,
  // An assignment of something that names itself a credential.
  /(?:api[_-]?key|token|secret|passwd|password|bearer|credential)\s*[:=]\s*\S{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

// A long unbroken run mixing letters and digits is what an opaque key looks
// like. Separators are excluded so ordinary long paths and identifiers are not
// mistaken for one; the patterns above catch the labelled forms.
const OPAQUE_RUN = /[A-Za-z0-9+]{40,}/g;

export function looksLikeSecret(value) {
  if (typeof value !== "string") return false;
  if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) return true;
  for (const run of value.match(OPAQUE_RUN) ?? []) {
    // A git object id is opaque and is not a credential. Commits, pinned
    // actions and tree ids are ordinary content in a repository and a spec.
    if (/^[0-9a-f]{40}$/.test(run)) continue;
    if (/[A-Za-z]/.test(run) && /[0-9]/.test(run)) return true;
  }
  return false;
}

// Environment names that announce themselves as credentials. `pix` forwards a
// bounded allowlist to the child and refuses to be the path a secret travels on.
const CREDENTIAL_KEY = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION_?ID|PRIVATE)/i;

export function looksLikeCredentialKey(key) {
  return CREDENTIAL_KEY.test(key);
}
