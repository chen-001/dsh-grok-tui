#!/usr/bin/env python3
"""Idempotently add the dsh-grok-tui usage rows to herdr's sidebar config.

Writes ~/.config/herdr/config.toml: appends a [ui.sidebar.agents] section
when absent, or merges the dsh rows into an existing section's rows array.
Never clobbers user rows; re-running is a no-op once "$dsh_cache" is present.
"""
import os
import sys

CONFIG = os.path.expanduser("~/.config/herdr/config.toml")
SECTION = "[ui.sidebar.agents]"
# herdr custom sidebar tokens are referenced with a `$` prefix — a bare
# `dsh_cache` fails config parsing ("unknown sidebar token ... must start
# with `$`"), so the rows quote the ${dsh.*} spelling.
NEW_LINES = (
    "# dsh-grok-tui usage metrics under the grok agent (installed by install.sh;\n"
    "# edit or remove freely)\n"
    "[ui.sidebar.agents]\n"
    'rows = [\n'
    '  ["state_icon", "workspace", "tab"],\n'
    '  ["agent"],\n'
    '  ["$dsh_cache", "$dsh_ttft", "$dsh_tps"],\n'
    '  ["$dsh_in", "$dsh_out"],\n'
    ']\n'
)
INSERT_LINES = (
    '  ["$dsh_cache", "$dsh_ttft", "$dsh_tps"],\n'
    '  ["$dsh_in", "$dsh_out"],\n'
)


def insert_rows(content: str):
    """Merge INSERT_LINES into the rows array of an existing agents section."""
    sec = content.index(SECTION)
    rest = content[sec + len(SECTION):]
    end = rest.find("\n[")
    body = rest if end == -1 else rest[:end]
    marker = "rows = ["
    arr = body.find(marker)
    if arr == -1:
        return None
    depth = 0
    i = body.index("[", arr)
    while i < len(body):
        ch = body[i]
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                break
        i += 1
    if depth != 0:
        return None
    prefix = body[:i]
    if prefix.rstrip().endswith(","):
        # Multi-line array: elements end with a comma; just insert a new row.
        return (
            content[: sec + len(SECTION) + i]
            + "\n"
            + INSERT_LINES
            + content[sec + len(SECTION) + i :]
        )
    # Single-line array (rows = [["a"],["b"]]): close the previous element
    # with a comma right before the closing bracket.
    return (
        content[: sec + len(SECTION) + i]
        + ","
        + "\n"
        + INSERT_LINES
        + content[sec + len(SECTION) + i :]
    )


def main():
    if os.path.exists(CONFIG):
        with open(CONFIG, encoding="utf-8") as handle:
            content = handle.read()
        if "$dsh_cache" in content:
            print(f"herdr sidebar already configured ({CONFIG})")
            return 0
        if SECTION in content:
            merged = insert_rows(content)
            if merged is None:
                print(
                    "warning: could not merge rows into the existing "
                    f"{SECTION} in {CONFIG} — add the rows manually:\n{NEW_LINES}",
                    file=sys.stderr,
                )
                return 1
            content = merged
        else:
            content = content.rstrip() + "\n\n" + NEW_LINES
    else:
        os.makedirs(os.path.dirname(CONFIG), exist_ok=True)
        content = NEW_LINES
    with open(CONFIG, "w", encoding="utf-8") as handle:
        handle.write(content)
    print(f"herdr sidebar configured at {CONFIG}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
