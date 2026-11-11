#!/usr/bin/env bash
# テストを一括で回す（2026-11-10 新設）
#
# 使い方（リポジトリ直下で）
#   bash scripts/test-all.sh            普通のテスト → エミュレータのテスト の2段
#   bash scripts/test-all.sh --no-emu   普通のテストだけ（Java・firebase 不要）
#   bash scripts/test-all.sh --emu-only エミュレータのテストだけ
#
# 1段目: scripts/test-*.mjs のうちエミュレータが要らないものを node で1本ずつ。
# 2段目: エミュレータが要る6本。
#   ・ルール3本（test-rules / test-rules-appconfig / test-rules-catchall）は、リポジトリの外の
#     作業フォルダ（既定 ${TMPDIR:-/tmp}/kjk-emu-run。EMU_RUN_DIR で変更可）に
#     @firebase/rules-unit-testing と firebase を入れ（入っていれば入れ直さない）、そこへコピーして動かす。
#   ・残り3本（test-office-merge-emu / test-warehouse-emu / test-trainer-emu）はリポジトリ直下で動かす。functions/node_modules が要る。
#     無ければ失敗扱いにして `cd functions && npm ci` を案内する（勝手に入れない）。
#     FUNCTIONS_NODE_MODULES に既存の node_modules のパスを渡すと、その間だけ symlink を張り、終わったら外す。
#
# 本番（kjk-tadakayo）には繋がない。プロジェクトIDは demo- で始まるものだけを使う。
# 終了コード: 全部合格 0 ／ 1本でも不合格（またはエミュレータの段を飛ばした）なら 1。
#
# 自己点検用: TEST_ALL_EXTRA に node で動かすファイルを空白区切りで渡すと、1段目の末尾に足して動かす
#   （例: TEST_ALL_EXTRA=scripts/no-such-test.mjs で「失敗したら終了コード1になるか」を確かめる）。

set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

RUN_NORMAL=1
RUN_EMU=1
for a in "$@"; do
  case "$a" in
    --no-emu) RUN_EMU=0 ;;
    --emu-only) RUN_NORMAL=0 ;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "知らないオプション: $a（--no-emu / --emu-only）" >&2; exit 2 ;;
  esac
done
if [ "$RUN_NORMAL" = 0 ] && [ "$RUN_EMU" = 0 ]; then
  echo "--no-emu と --emu-only は同時に指定できません" >&2; exit 2
fi

EMU_TESTS=(test-rules.mjs test-rules-appconfig.mjs test-rules-catchall.mjs test-office-merge-emu.mjs test-warehouse-emu.mjs test-trainer-emu.mjs)

TMP_OUT="$(mktemp -d "${TMPDIR:-/tmp}/kjk-test-all.XXXXXX")"
LINKED_NM=""          # このスクリプトが張った functions/node_modules の symlink
NEW_DEBUG_LOG=""      # このスクリプトの実行で新しくできた firestore-debug.log
cleanup() {
  if [ -n "$LINKED_NM" ] && [ -L "$LINKED_NM" ]; then rm -f "$LINKED_NM"; fi
  if [ -n "$NEW_DEBUG_LOG" ] && [ -f "$NEW_DEBUG_LOG" ]; then rm -f "$NEW_DEBUG_LOG"; fi
  rm -rf "$TMP_OUT"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

N_PASS=0; N_FAIL=0; E_PASS=0; E_FAIL=0; E_SKIPPED=""
FAILED_LOGS=()

# $1=段（normal|emu） $2=表示名 $3=出力ファイル $4=終了コード
record() {
  local stage="$1" name="$2" out="$3" rc="$4"
  if [ "$rc" = 0 ]; then
    # テストが最後に出す件数の行（「合計: 203/203 合格」など）があれば添える
    local note
    note="$(grep -E '合計|合格|passed' "$out" 2>/dev/null | tail -1 | sed 's/^[[:space:]]*//' | cut -c1-80)"
    if [ -n "$note" ]; then echo "PASS  $name  … $note"; else echo "PASS  $name"; fi
    if [ "$stage" = normal ]; then N_PASS=$((N_PASS+1)); else E_PASS=$((E_PASS+1)); fi
  else
    echo "FAIL  $name（終了コード $rc）"
    if [ "$stage" = normal ]; then N_FAIL=$((N_FAIL+1)); else E_FAIL=$((E_FAIL+1)); fi
    FAILED_LOGS+=("$name|$out")
  fi
}

# 失敗扱いにするだけ（出力ファイルに理由を書く）
record_fail_msg() {
  local stage="$1" name="$2" msg="$3"
  local out="$TMP_OUT/$(echo "$name" | tr '/ ' '__').msg"
  echo "$msg" > "$out"
  record "$stage" "$name" "$out" 1
}

# ---------------- 1段目: 普通のテスト ----------------
if [ "$RUN_NORMAL" = 1 ]; then
  echo "== 普通のテスト（node）=="
  NORMAL_LIST=()
  for f in scripts/test-*.mjs; do
    b="$(basename "$f")"
    skip=0
    for e in "${EMU_TESTS[@]}"; do [ "$b" = "$e" ] && skip=1; done
    [ "$skip" = 0 ] && NORMAL_LIST+=("$f")
  done
  for x in ${TEST_ALL_EXTRA:-}; do NORMAL_LIST+=("$x"); done
  for f in "${NORMAL_LIST[@]}"; do
    out="$TMP_OUT/$(basename "$f").out"
    node "$f" > "$out" 2>&1 < /dev/null
    record normal "$f" "$out" $?
  done
fi

# ---------------- 2段目: エミュレータのテスト ----------------
if [ "$RUN_EMU" = 1 ]; then
  echo "== エミュレータのテスト =="

  # Java
  if [ -x /opt/homebrew/opt/openjdk/bin/java ]; then
    export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
  fi
  if ! command -v java >/dev/null 2>&1 || ! java -version >/dev/null 2>&1; then
    E_SKIPPED="Java が見つからない（brew install openjdk か、PATH に java を通す）"
  fi

  # firebase: bash から直接呼べればそれを、だめなら zsh の関数ラッパー経由
  FB_MODE=""
  if [ -z "$E_SKIPPED" ]; then
    if command -v firebase >/dev/null 2>&1 && firebase --version >/dev/null 2>&1; then
      FB_MODE=direct
    elif command -v zsh >/dev/null 2>&1 && zsh -ic 'firebase --version' >/dev/null 2>&1; then
      FB_MODE=zsh
    else
      E_SKIPPED="firebase CLI が見つからない（npm i -g firebase-tools）"
    fi
  fi

  fb() {
    if [ "$FB_MODE" = direct ]; then
      firebase "$@"
    else
      local cmd="firebase" a
      for a in "$@"; do cmd+=" $(printf '%q' "$a")"; done
      zsh -ic "$cmd"
    fi
  }

  # 本番に繋がないための関所: demo- 以外のプロジェクトIDでは動かさない
  emu_exec() {  # $1=プロジェクトID 残り=firebase の引数
    local pid="$1"; shift
    case "$pid" in
      demo-*) ;;
      *) echo "プロジェクトID '$pid' は demo- で始まらないので実行しない"; return 3 ;;
    esac
    fb emulators:exec --project "$pid" "$@"
  }

  if [ -n "$E_SKIPPED" ]; then
    echo "!! エミュレータの段は飛ばした: $E_SKIPPED"
  else
    echo "   firebase の呼び方: $FB_MODE ／ java: $(command -v java)"

    # --- ルール3本（リポジトリ外の作業フォルダで） ---
    EMU_RUN_DIR="${EMU_RUN_DIR:-${TMPDIR:-/tmp}/kjk-emu-run}"
    EMU_RUN_DIR="${EMU_RUN_DIR%/}"
    # ../ や symlink を解いた実際の場所で比べる（無ければ親フォルダで解く）
    if [ -d "$EMU_RUN_DIR" ]; then
      EMU_RUN_DIR="$(cd "$EMU_RUN_DIR" && pwd -P)"
    elif [ -d "$(dirname "$EMU_RUN_DIR")" ]; then
      EMU_RUN_DIR="$(cd "$(dirname "$EMU_RUN_DIR")" && pwd -P)/$(basename "$EMU_RUN_DIR")"
    fi
    REPO_REAL="$(pwd -P)"
    prep_ok=1
    case "$EMU_RUN_DIR/" in
      "$REPO_REAL"/*|"$REPO"/*) echo "!! EMU_RUN_DIR がリポジトリの中を指している: $EMU_RUN_DIR"; prep_ok=0 ;;
    esac
    if [ "$prep_ok" = 1 ]; then
      mkdir -p "$EMU_RUN_DIR"
      if [ ! -d "$EMU_RUN_DIR/node_modules/@firebase/rules-unit-testing" ] || [ ! -d "$EMU_RUN_DIR/node_modules/firebase" ]; then
        echo "   部品を入れる: $EMU_RUN_DIR（@firebase/rules-unit-testing firebase）"
        prep_out="$TMP_OUT/emu-prep.out"
        if ! ( cd "$EMU_RUN_DIR" && { [ -f package.json ] || npm init -y >/dev/null; } && npm i @firebase/rules-unit-testing firebase ) > "$prep_out" 2>&1; then
          echo "!! 部品のインストールに失敗（末尾）:"; tail -20 "$prep_out"
          prep_ok=0
        fi
      fi
    fi
    for t in test-rules.mjs test-rules-appconfig.mjs test-rules-catchall.mjs; do
      if [ "$prep_ok" = 0 ]; then
        record_fail_msg emu "scripts/$t" "作業フォルダ（$EMU_RUN_DIR）の準備ができなかった"
        continue
      fi
      cp "scripts/$t" "$EMU_RUN_DIR/$t"
      out="$TMP_OUT/$t.out"
      if [ "$t" = test-rules.mjs ]; then
        ( cd "$EMU_RUN_DIR" && RULES_DIR="$REPO" emu_exec demo-kjk --config "$REPO/firebase.json" --only firestore,storage "node $t" ) > "$out" 2>&1 < /dev/null
      else
        ( cd "$EMU_RUN_DIR" && RULES_FILE="$REPO/firestore.rules" emu_exec demo-kjk --config "$REPO/firebase.json" --only firestore "node $t" ) > "$out" 2>&1 < /dev/null
      fi
      record emu "scripts/$t" "$out" $?
    done

    # --- functions を使う3本（リポジトリ直下で） ---
    nm_ok=1
    if [ ! -e functions/node_modules ]; then
      if [ -n "${FUNCTIONS_NODE_MODULES:-}" ]; then
        if [ -d "$FUNCTIONS_NODE_MODULES" ]; then
          ln -s "$FUNCTIONS_NODE_MODULES" functions/node_modules && LINKED_NM="$REPO/functions/node_modules"
          echo "   functions/node_modules を一時的に symlink: $FUNCTIONS_NODE_MODULES（終わったら外す）"
        else
          echo "!! FUNCTIONS_NODE_MODULES のフォルダが無い: $FUNCTIONS_NODE_MODULES"; nm_ok=0
        fi
      else
        nm_ok=0
      fi
    fi
    [ -f firestore-debug.log ] || NEW_DEBUG_LOG="$REPO/firestore-debug.log"
    for spec in "test-office-merge-emu.mjs demo-office-test" "test-warehouse-emu.mjs demo-warehouse-test" "test-trainer-emu.mjs demo-trainer-test"; do
      t="${spec% *}"; pid="${spec#* }"
      if [ "$nm_ok" = 0 ]; then
        record_fail_msg emu "scripts/$t" "functions/node_modules が無い。\`cd functions && npm ci\` を実行してから（または FUNCTIONS_NODE_MODULES に既存の node_modules のパスを渡す）"
        continue
      fi
      out="$TMP_OUT/$t.out"
      emu_exec "$pid" --only firestore "node scripts/$t" > "$out" 2>&1 < /dev/null
      record emu "scripts/$t" "$out" $?
    done
    # symlink はここで外す（trap でも外す）
    if [ -n "$LINKED_NM" ] && [ -L "$LINKED_NM" ]; then rm -f "$LINKED_NM"; LINKED_NM=""; fi
  fi
fi

# ---------------- 失敗の詳細 ----------------
if [ "${#FAILED_LOGS[@]}" -gt 0 ]; then
  echo
  echo "== 失敗したテストの出力（末尾20行）=="
  for item in "${FAILED_LOGS[@]}"; do
    name="${item%%|*}"; out="${item#*|}"
    echo "--- $name ---"
    tail -20 "$out"
  done
fi

# ---------------- まとめ ----------------
echo
summary=""
if [ "$RUN_NORMAL" = 1 ]; then summary="普通のテスト: pass=$N_PASS fail=$N_FAIL"; else summary="普通のテスト: （実行せず）"; fi
if [ "$RUN_EMU" = 0 ]; then
  summary+=" ／ エミュレータ: （実行せず）"
elif [ -n "$E_SKIPPED" ]; then
  summary+=" ／ エミュレータ: 飛ばした（$E_SKIPPED）"
else
  summary+=" ／ エミュレータ: pass=$E_PASS fail=$E_FAIL"
fi
echo "$summary"

if [ $((N_FAIL + E_FAIL)) -gt 0 ] || [ -n "$E_SKIPPED" ]; then exit 1; fi
exit 0
