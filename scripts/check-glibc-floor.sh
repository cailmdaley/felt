#!/usr/bin/env bash
# check-glibc-floor.sh <release-dir>
#
# Fail if any ELF binary under <release-dir> requires a glibc/libstdc++/libgcc
# symbol version newer than the oldest distribution we support.
#
# Why this exists: the Shuttle daemon ships as an ERTS-bundled Mix release —
# prebuilt native binaries (beam.smp, erl_child_setup, every NIF .so). Those
# binaries inherit the symbol-version floor of whatever host compiled them. Built
# on ubuntu-latest they reference GLIBC_2.38, and every HPC cluster we use
# (RHEL/Rocky/Alma 8, glibc 2.28) refuses to load them.
#
# The release workflow's boot test cannot catch this: it runs on the build host,
# where the symbols it needs are by definition present. This check reads the
# requirement out of the artifact itself, so it is true regardless of where it
# runs.
#
# Floors default to the EL8 / manylinux_2_28 baseline (gcc-8 toolchain) and are
# overridable:
#   GLIBC_FLOOR=2.28  GLIBCXX_FLOOR=3.4.25  GCC_FLOOR=7.0.0
#
# objdump: taken from $OBJDUMP, else PATH, else Homebrew's binutils. macOS's
# /usr/bin/objdump is llvm-objdump, which reads Linux ELF and prints versions as
# "(GLIBC_2.28)"; GNU objdump prints them bare. Both are matched.
#
# Usage:
#   scripts/check-glibc-floor.sh out/shuttle
#   GLIBC_FLOOR=2.34 scripts/check-glibc-floor.sh /tmp/untarred/shuttle

set -euo pipefail

dir="${1:-}"
if [ -z "$dir" ] || [ ! -d "$dir" ]; then
  echo "usage: $0 <release-dir>" >&2
  exit 2
fi

GLIBC_FLOOR="${GLIBC_FLOOR:-2.28}"
GLIBCXX_FLOOR="${GLIBCXX_FLOOR:-3.4.25}"
GCC_FLOOR="${GCC_FLOOR:-7.0.0}"

# --- locate objdump -----------------------------------------------------------
objdump_bin="${OBJDUMP:-}"
if [ -z "$objdump_bin" ]; then
  for candidate in objdump gobjdump /opt/homebrew/opt/binutils/bin/objdump \
                   /usr/local/opt/binutils/bin/objdump; do
    if command -v "$candidate" >/dev/null 2>&1; then
      objdump_bin="$candidate"
      break
    fi
  done
fi
if [ -z "$objdump_bin" ]; then
  echo "check-glibc-floor: no objdump found (set \$OBJDUMP, or brew install binutils)" >&2
  exit 2
fi

# --- collect ELF files --------------------------------------------------------
# Identify by magic bytes (\x7fELF), not `file`: `file` is not guaranteed present
# in a minimal container image, and the release is mostly .beam bytecode that
# heuristics can misread.
elf_files=()
while IFS= read -r -d '' f; do
  # `head -c 4 | od` avoids depending on how the shell handles NUL bytes.
  magic="$(head -c 4 "$f" 2>/dev/null | od -An -tx1 | tr -d ' \n')"
  if [ "$magic" = "7f454c46" ]; then
    elf_files+=("$f")
  fi
done < <(find "$dir" -type f -print0)

if [ "${#elf_files[@]}" -eq 0 ]; then
  echo "check-glibc-floor: no ELF files under $dir — nothing to check." >&2
  echo "(That is itself suspicious for a Linux release; verify the path.)" >&2
  exit 2
fi

# --- extract the required symbol versions -------------------------------------
# One objdump pass per file, its version tokens cached in file_syms[i], so the
# summary and the per-family offender lists below never re-read a binary.
#
# `|| true` before the pipe is load-bearing: grep must consume the whole stream
# (no `grep -q`), and objdump must not be allowed to fail the pipeline under
# `pipefail` when it cannot parse a stray ELF. Matches both "GLIBC_2.28" (GNU
# objdump) and "(GLIBC_2.28)" (llvm-objdump).
file_syms=()
all_syms=""
for f in "${elf_files[@]}"; do
  syms="$({ "$objdump_bin" -T "$f" 2>/dev/null || true; } |
    grep -oE '\b(GLIBC|GLIBCXX|GCC)_[0-9]+(\.[0-9]+)*\b' | sort -u || true)"
  file_syms+=("$syms")
  all_syms+="$syms"$'\n'
done
all_syms="$(printf '%s' "$all_syms" | sort -u)"

# max_version <family> -> highest x.y[.z] seen for that family, or empty.
#
# The `|| true` is load-bearing under `set -euo pipefail`. An absent family is a
# legitimate result, not an error — a purely C tree references no GLIBCXX_ or
# GCC_ symbols at all (EL8's packaged erlang-erts is one such). Without the
# guard grep exits 1, pipefail propagates it out of the command substitution,
# and errexit kills the script mid-report: it prints a bare "GLIBC ... ok" and
# exits 1. The same fault truncated the offender list on a genuine violation,
# because the reporting loop died at the next family.
max_version() {
  { printf '%s\n' "$all_syms" | grep -E "^$1_" || true; } |
    sed -E "s/^$1_//" |
    sort -V |
    tail -n 1
}

# version_gt a b -> true when a is strictly newer than b
version_gt() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$1" ]
}

status=0
printf '%-10s %-12s %-12s %s\n' "FAMILY" "REQUIRED" "FLOOR" "VERDICT"
for family in GLIBC GLIBCXX GCC; do
  case "$family" in
    GLIBC)    floor="$GLIBC_FLOOR" ;;
    GLIBCXX)  floor="$GLIBCXX_FLOOR" ;;
    GCC)      floor="$GCC_FLOOR" ;;
  esac
  required="$(max_version "$family")"
  if [ -z "$required" ]; then
    printf '%-10s %-12s %-12s %s\n' "$family" "-" "$floor" "not referenced"
    continue
  fi
  if version_gt "$required" "$floor"; then
    printf '%-10s %-12s %-12s %s\n' "$family" "$required" "$floor" "FAIL"
    status=1
  else
    printf '%-10s %-12s %-12s %s\n' "$family" "$required" "$floor" "ok"
  fi
done

echo
echo "checked ${#elf_files[@]} ELF file(s) under $dir using $objdump_bin"

if [ "$status" -ne 0 ]; then
  echo >&2
  for family in GLIBC GLIBCXX GCC; do
    case "$family" in
      GLIBC)    floor="$GLIBC_FLOOR" ;;
      GLIBCXX)  floor="$GLIBCXX_FLOOR" ;;
      GCC)      floor="$GCC_FLOOR" ;;
    esac
    required="$(max_version "$family")"
    if [ -n "$required" ] && version_gt "$required" "$floor"; then
      echo "artifact needs ${family}_${required} > floor ${floor} — built on too new a host" >&2
      # Name the offending files so the reader knows where to look.
      for i in "${!elf_files[@]}"; do
        if printf '%s\n' "${file_syms[$i]}" |
             grep -qxF "${family}_${required}"; then
          echo "    ${elf_files[$i]}" >&2
        fi
      done
    fi
  done
  echo >&2
  echo "Build the Linux daemon legs inside the EL8 container (see .github/workflows/release.yml)." >&2
  exit 1
fi
