// POSIX sh so the hook never needs node on PATH and never delays the agent.
export const HOOK_HELPER_SCRIPT = `#!/bin/sh
# Sidecar hook helper. Writes one agent event to the Sidecar spool and exits.
# Managed by Sidecar — edits are overwritten on reinstall.
set -u
home="\${SIDECAR_HOME:-$HOME/.sidecar}"
dir="$home/hooks"
mkdir -p "$dir" 2>/dev/null || exit 0
harness="\${1:-claude}"
type="\${2:-unknown}"
payload=$(cat 2>/dev/null)
[ -n "$payload" ] || payload=null
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Spool files are drained in name order, so the name must sort by arrival.
# %N is unsupported on older macOS date; fall back to whole seconds there.
stamp=$(date -u +%Y%m%d%H%M%S%N)
case "$stamp" in
  *[!0-9]*) stamp="$(date -u +%Y%m%d%H%M%S)000000000" ;;
esac
base="$dir/$stamp-$$-$harness-$type"
{
  printf '{"ts":"%s","harness":"%s","type":"%s","payload":' "$ts" "$harness" "$type"
  printf '%s' "$payload"
  printf '}'
} > "$base.tmp" 2>/dev/null && mv "$base.tmp" "$base.json" 2>/dev/null
exit 0
`;
