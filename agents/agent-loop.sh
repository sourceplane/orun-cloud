#!/usr/bin/env bash
set -euo pipefail

WAIT_SECONDS="${WAIT_SECONDS:-60}"

ORCHESTRATOR_MODEL="${ORCHESTRATOR_MODEL:-gpt-5.5}"
TASK_MODEL="${TASK_MODEL:-gpt-5.4}"

TASK_CLI="${TASK_CLI:-copilot}"
ORCHESTRATOR_CLI="${ORCHESTRATOR_CLI:-codex}"

OPENCODE_AGENT="${OPENCODE_AGENT:-build}"
OPENCODE_ORCHESTRATOR_AGENT="${OPENCODE_ORCHESTRATOR_AGENT:-}"

MAX_LOOPS=0
START_WITH_TASK=false
RESUME_ORCHESTRATOR=true

# Agent home is where ai/state.json is expected.
# Run this script from that directory by default.
AGENT_HOME_DIR="${AGENT_HOME_DIR:-$(pwd)}"

# Workspace is where the coding task agent should operate.
# Relative paths are resolved from AGENT_HOME_DIR.
WORKSPACE_DIR="${WORKSPACE_DIR:-$AGENT_HOME_DIR}"

ORCHESTRATOR_FIRST_PROMPT="${ORCHESTRATOR_FIRST_PROMPT:-Act as orchestrator.md}"
ORCHESTRATOR_RESUME_PROMPT="${ORCHESTRATOR_RESUME_PROMPT:-Continue acting as orchestrator.md. Review latest task/verify state and produce the next orchestration step.}"

usage() {
  cat <<EOF
Usage:
  $0 [options]

Options:
  --task-cli copilot|opencode|codex
  --orchestrator-cli codex|opencode
  --opencode-orchestrator
  --orchestrator-model MODEL
  --task-model MODEL
  --opencode-agent AGENT
  --opencode-orchestrator-agent AGENT
  --start-with-task
  --skip-first-orchestrator
  --max-loops N
  --wait SECONDS
  --workspace-dir PATH
  --workspace PATH
  --agent-home-dir PATH
  --no-resume-orchestrator
  --help

Directory model:
  agent-home-dir:
    Directory where ai/state.json, ai/waiting_for_input.md, and orchestrator.md are expected.

  workspace-dir:
    Directory where the coding/task agent should operate.
    Relative paths are resolved from agent-home-dir.

Examples:
  cd /repo/agents

  ./agent-loop.sh \\
    --workspace-dir ../ \\
    --orchestrator-cli opencode \\
    --orchestrator-model github-copilot/claude-opus-4.6 \\
    --task-cli opencode \\
    --task-model github-copilot/claude-opus-4.6 \\
    --opencode-agent build \\
    --max-loops 2
EOF
}

abs_path_from() {
  local base_dir="$1"
  local input_path="$2"
  local target_path

  if [[ -z "$input_path" ]]; then
    echo "Error: path cannot be empty" >&2
    exit 1
  fi

  if [[ "$input_path" = /* ]]; then
    target_path="$input_path"
  else
    target_path="$base_dir/$input_path"
  fi

  if [[ ! -d "$target_path" ]]; then
    echo "Error: directory does not exist: $target_path" >&2
    exit 1
  fi

  (
    cd "$target_path"
    pwd
  )
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task-cli)
      TASK_CLI="${2:-}"
      shift 2
      ;;
    --orchestrator-cli)
      ORCHESTRATOR_CLI="${2:-}"
      shift 2
      ;;
    --opencode-orchestrator)
      ORCHESTRATOR_CLI="opencode"
      shift
      ;;
    --orchestrator-model)
      ORCHESTRATOR_MODEL="${2:-}"
      shift 2
      ;;
    --task-model)
      TASK_MODEL="${2:-}"
      shift 2
      ;;
    --opencode-agent)
      OPENCODE_AGENT="${2:-}"
      shift 2
      ;;
    --opencode-orchestrator-agent)
      OPENCODE_ORCHESTRATOR_AGENT="${2:-}"
      shift 2
      ;;
    --start-with-task|--skip-first-orchestrator)
      START_WITH_TASK=true
      shift
      ;;
    --max-loops)
      MAX_LOOPS="${2:-}"
      if [[ -z "$MAX_LOOPS" || ! "$MAX_LOOPS" =~ ^[0-9]+$ ]]; then
        echo "Error: --max-loops requires a number" >&2
        exit 1
      fi
      shift 2
      ;;
    --wait)
      WAIT_SECONDS="${2:-}"
      if [[ -z "$WAIT_SECONDS" || ! "$WAIT_SECONDS" =~ ^[0-9]+$ ]]; then
        echo "Error: --wait requires seconds" >&2
        exit 1
      fi
      shift 2
      ;;
    --workspace-dir|--workspace)
      WORKSPACE_DIR="${2:-}"
      shift 2
      ;;
    --agent-home-dir)
      AGENT_HOME_DIR="${2:-}"
      shift 2
      ;;
    --no-resume-orchestrator)
      RESUME_ORCHESTRATOR=false
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

case "$TASK_CLI" in
  copilot|opencode|codex)
    ;;
  *)
    echo "Error: unsupported --task-cli '${TASK_CLI}'. Use one of: copilot, opencode, codex" >&2
    exit 1
    ;;
esac

case "$ORCHESTRATOR_CLI" in
  codex|opencode)
    ;;
  *)
    echo "Error: unsupported --orchestrator-cli '${ORCHESTRATOR_CLI}'. Use one of: codex, opencode" >&2
    exit 1
    ;;
esac

# If no dedicated OpenCode orchestrator agent is given, reuse the task OpenCode agent.
# This avoids assuming an 'orchestrator' agent exists in opencode config.
if [[ -z "$OPENCODE_ORCHESTRATOR_AGENT" ]]; then
  OPENCODE_ORCHESTRATOR_AGENT="$OPENCODE_AGENT"
fi

# Normalize paths after parsing args.
AGENT_HOME_DIR="$(abs_path_from "$(pwd)" "$AGENT_HOME_DIR")"
WORKSPACE_DIR="$(abs_path_from "$AGENT_HOME_DIR" "$WORKSPACE_DIR")"

STATE_FILE="$AGENT_HOME_DIR/ai/state.json"
WAITING_FOR_INPUT_FILE="$AGENT_HOME_DIR/ai/waiting_for_input.md"

echo "home:         $AGENT_HOME_DIR"
echo "workspace:    $WORKSPACE_DIR"
echo "orchestrator: $ORCHESTRATOR_CLI model=$ORCHESTRATOR_MODEL"
echo "task-runner:  $TASK_CLI model=$TASK_MODEL"

run_in_dir() {
  local dir="$1"
  shift

  (
    cd "$dir"
    "$@"
  )
}

require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "Error: jq is required but not installed" >&2
    exit 1
  fi
}

exit_if_waiting_for_input() {
  if [[ ! -f "$STATE_FILE" ]]; then
    return 0
  fi

  require_jq

  local waiting_for_input
  waiting_for_input="$(jq -r '.waiting_for_input // "false"' "$STATE_FILE")"

  if [[ "$waiting_for_input" == "true" ]]; then
    echo "⏸ Waiting for human input. Exiting agent loop."

    if [[ -f "$WAITING_FOR_INPUT_FILE" ]]; then
      cat "$WAITING_FOR_INPUT_FILE"
    else
      echo "$WAITING_FOR_INPUT_FILE is missing."
    fi

    exit 0
  fi
}

resolve_task_agent_ref() {
  local task_agent="$1"

  if [[ "$task_agent" = /* ]]; then
    echo "$task_agent"
    return 0
  fi

  if [[ -e "$AGENT_HOME_DIR/$task_agent" ]]; then
    echo "$AGENT_HOME_DIR/$task_agent"
    return 0
  fi

  echo "$task_agent"
}

get_task_runner_prompt() {
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "Error: ai/state.json not found in agent home: $AGENT_HOME_DIR" >&2
    echo "Hint: run this script from the directory containing ai/state.json, or pass --agent-home-dir PATH." >&2
    exit 1
  fi

  require_jq

  local task_agent
  task_agent="$(jq -r '.task_agent // empty' "$STATE_FILE")"

  if [[ -z "$task_agent" || "$task_agent" == "null" ]]; then
    echo "Error: .task_agent is missing or empty in $STATE_FILE" >&2
    exit 1
  fi

  local resolved_task_agent
  resolved_task_agent="$(resolve_task_agent_ref "$task_agent")"

  echo "act as ${resolved_task_agent}"
}

ORCHESTRATOR_HAS_SESSION=false

run_orchestrator_codex() {
  local prompt="$1"

  local codex_flags=(
    --skip-git-repo-check
    --model "$ORCHESTRATOR_MODEL"
    --dangerously-bypass-approvals-and-sandbox
  )

  if [[ "$RESUME_ORCHESTRATOR" == true && "$ORCHESTRATOR_HAS_SESSION" == true ]]; then
    echo "▶ Resuming orchestrator with Codex ${ORCHESTRATOR_MODEL}..."

    run_in_dir "$AGENT_HOME_DIR" \
      codex exec resume \
      --last \
      "${codex_flags[@]}" \
      "$prompt"
  else
    echo "▶ Starting orchestrator with Codex ${ORCHESTRATOR_MODEL}..."

    run_in_dir "$AGENT_HOME_DIR" \
      codex exec \
      "${codex_flags[@]}" \
      "$prompt"

    ORCHESTRATOR_HAS_SESSION=true
  fi
}

run_orchestrator_opencode() {
  local prompt="$1"

  if [[ "$ORCHESTRATOR_HAS_SESSION" == true ]]; then
    echo "▶ Running orchestrator with OpenCode ${ORCHESTRATOR_MODEL} agent=${OPENCODE_ORCHESTRATOR_AGENT}..."
  else
    echo "▶ Starting orchestrator with OpenCode ${ORCHESTRATOR_MODEL} agent=${OPENCODE_ORCHESTRATOR_AGENT}..."
    ORCHESTRATOR_HAS_SESSION=true
  fi

  opencode run \
    --dir "$AGENT_HOME_DIR" \
    --model "$ORCHESTRATOR_MODEL" \
    --agent "$OPENCODE_ORCHESTRATOR_AGENT" \
    --dangerously-skip-permissions \
    "$prompt"
}

run_orchestrator() {
  local prompt="$ORCHESTRATOR_FIRST_PROMPT"

  if [[ "$ORCHESTRATOR_HAS_SESSION" == true ]]; then
    prompt="$ORCHESTRATOR_RESUME_PROMPT"
  fi

  case "$ORCHESTRATOR_CLI" in
    codex)
      run_orchestrator_codex "$prompt"
      ;;
    opencode)
      run_orchestrator_opencode "$prompt"
      ;;
  esac
}

run_task_runner_copilot() {
  local prompt
  prompt="$(get_task_runner_prompt)"

  echo "▶ Running task-runner with Copilot ${TASK_MODEL}..."
  echo "   home: $AGENT_HOME_DIR"
  echo "   workspace: $WORKSPACE_DIR"
  echo "   prompt: ${prompt}"

  run_in_dir "$WORKSPACE_DIR" \
    copilot \
    --model "$TASK_MODEL" \
    --prompt "$prompt" \
    --allow-all
}

run_task_runner_opencode() {
  local prompt
  prompt="$(get_task_runner_prompt)"

  echo "▶ Running task-runner with OpenCode ${TASK_MODEL} agent=${OPENCODE_AGENT}..."
  echo "   home: $AGENT_HOME_DIR"
  echo "   workspace: $WORKSPACE_DIR"
  echo "   prompt: ${prompt}"

  opencode run \
    --dir "$WORKSPACE_DIR" \
    --model "$TASK_MODEL" \
    --agent "$OPENCODE_AGENT" \
    --dangerously-skip-permissions \
    "$prompt"
}

run_task_runner_codex() {
  local prompt
  prompt="$(get_task_runner_prompt)"

  echo "▶ Running task-runner with Codex ${TASK_MODEL}..."
  echo "   home: $AGENT_HOME_DIR"
  echo "   workspace: $WORKSPACE_DIR"
  echo "   prompt: ${prompt}"

  run_in_dir "$WORKSPACE_DIR" \
    codex exec \
    --skip-git-repo-check \
    --model "$TASK_MODEL" \
    --dangerously-bypass-approvals-and-sandbox \
    "$prompt"
}

run_task_runner() {
  case "$TASK_CLI" in
    copilot)
      run_task_runner_copilot
      ;;
    opencode)
      run_task_runner_opencode
      ;;
    codex)
      run_task_runner_codex
      ;;
  esac
}

wait_between_runs() {
  echo "⏳ Waiting ${WAIT_SECONDS}s..."
  sleep "$WAIT_SECONDS"
}

if [[ "$START_WITH_TASK" == true ]]; then
  exit_if_waiting_for_input
  echo "↷ Starting with task-runner using ${TASK_CLI}..."
  run_task_runner
  wait_between_runs
fi

loop_count=0

while true; do
  loop_count=$((loop_count + 1))
  echo "🔁 Loop ${loop_count}"

  exit_if_waiting_for_input
  run_orchestrator
  wait_between_runs

  exit_if_waiting_for_input
  run_task_runner

  if [[ "$MAX_LOOPS" -gt 0 && "$loop_count" -ge "$MAX_LOOPS" ]]; then
    echo "✅ Reached max loops: ${MAX_LOOPS}. Exiting."
    exit 0
  fi

  wait_between_runs
done
