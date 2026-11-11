# Add these lines to your Claude Code status line script, right after it reads its
# input (for example after `input=$(cat)`). They save your plan limits to
# ~/.claude/usage-limits.json, which the Herdr Arcade mana bar reads. Needs jq.
# rate_limits only appears for Claude Pro/Max subscriptions.
limits=$(echo "$input" | jq -c 'select(.rate_limits) | {at: (now | floor), five_hour: .rate_limits.five_hour, seven_day: .rate_limits.seven_day}' 2>/dev/null)
[ -n "$limits" ] && printf '%s' "$limits" > "$HOME/.claude/usage-limits.json.tmp" && mv "$HOME/.claude/usage-limits.json.tmp" "$HOME/.claude/usage-limits.json"
