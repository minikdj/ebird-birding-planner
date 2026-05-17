#!/usr/bin/env python3
"""
generate-shortcut.py — builds BirdReport.shortcut for iOS.

Usage:
    python3 scripts/generate-shortcut.py YOUR_GITHUB_PAT

Then AirDrop BirdReport.shortcut to your iPhone and tap to install.

The Shortcut will:
  1. Ask for a location (default: Cincinnati, OH)
  2. Ask for an optional focus (e.g. warblers)
  3. POST to GitHub Actions to trigger the on-demand birding report
  4. Show a confirmation notification

Requires: Python 3.6+ (uses only stdlib — plistlib, uuid, sys)
"""

import plistlib
import sys
import uuid


# ---------------------------------------------------------------------------
# Config — edit region/lat/lng if your default location differs
# ---------------------------------------------------------------------------

DEFAULT_LOCATION = "Cincinnati, OH"
DEFAULT_REGION   = "US-OH-061"
DEFAULT_LAT      = "39.1"
DEFAULT_LNG      = "-84.5"
REPO             = "minikdj/ebird-birding-planner"
WORKFLOW_FILE    = "report-on-demand.yml"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def uid():
    return str(uuid.uuid4()).upper()


def simple_text(s):
    """Static WFTextTokenString with no variable attachments."""
    return {
        "Value": {"string": s},
        "WFSerializationType": "WFTextTokenString",
    }


def text_with_vars(parts):
    """
    Build a WFTextTokenString that interpolates named Shortcuts variables.

    parts: list of str | {"var": "VariableName"}

    Each variable is represented as a U+FFFC object-replacement-character
    placeholder in the string, with its position recorded in attachmentsByRange.
    """
    result = ""
    attachments = {}
    for part in parts:
        if isinstance(part, str):
            result += part
        else:
            loc = len(result)
            result += "￼"          # one-character placeholder per variable
            attachments[f"{{{loc}, 1}}"] = {
                "Type": "Variable",
                "VariableName": part["var"],
            }
    val = {"string": result}
    if attachments:
        val["attachmentsByRange"] = attachments
    return {"Value": val, "WFSerializationType": "WFTextTokenString"}


# ---------------------------------------------------------------------------
# Action builders
# ---------------------------------------------------------------------------

def ask_action(prompt, default=""):
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.ask",
        "WFWorkflowActionParameters": {
            "WFAskActionDefaultAnswer": default,
            "WFAskActionInputType": "Text",
            "WFAskActionPrompt": prompt,
            "UUID": uid(),
        },
    }


def set_variable_action(name):
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.setvariable",
        "WFWorkflowActionParameters": {
            "WFVariableName": name,
            "UUID": uid(),
        },
    }


def text_action(token_string):
    """The 'Text' action — outputs a static or interpolated string."""
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.gettext",
        "WFWorkflowActionParameters": {
            "WFTextActionText": token_string,
            "UUID": uid(),
        },
    }


def http_post_action(url, headers, body_variable):
    """
    'Get Contents of URL' — POST with File body sourced from a named variable.
    The variable must contain the raw JSON string.
    """
    header_items = [
        {
            "WFItemType": 0,                  # 0 = Text
            "WFKey":   simple_text(k),
            "WFValue": simple_text(v),
        }
        for k, v in headers.items()
    ]
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl",
        "WFWorkflowActionParameters": {
            "WFURL": simple_text(url),
            "WFHTTPMethod": "POST",
            "WFHTTPHeaders": {
                "Value": {"WFDictionaryFieldValueItems": header_items},
                "WFSerializationType": "WFDictionaryFieldValue",
            },
            "WFHTTPBodyType": "File",
            "WFRequestVariable": {
                "Value": {
                    "Type": "Variable",
                    "VariableName": body_variable,
                },
                "WFSerializationType": "WFTextTokenAttachment",
            },
            "UUID": uid(),
        },
    }


def show_result_action(message):
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.showresult",
        "WFWorkflowActionParameters": {
            "WFResultAlert": simple_text(message),
            "UUID": uid(),
        },
    }


# ---------------------------------------------------------------------------
# Build action list
# ---------------------------------------------------------------------------

def build_actions(pat):
    dispatch_url = (
        f"https://api.github.com/repos/{REPO}"
        f"/actions/workflows/{WORKFLOW_FILE}/dispatches"
    )

    # JSON body with Location and Focus variables interpolated
    json_body_token = text_with_vars([
        '{"ref":"main","inputs":{"location":"',
        {"var": "Location"},
        f'","region":"{DEFAULT_REGION}","lat":"{DEFAULT_LAT}"'
        f',"lng":"{DEFAULT_LNG}","focus":"',
        {"var": "Focus"},
        '"}}',
    ])

    return [
        # 1. Ask for location
        ask_action(
            "Location name (e.g. Cape May, NJ)",
            default=DEFAULT_LOCATION,
        ),
        # 2. Save it
        set_variable_action("Location"),

        # 3. Ask for focus
        ask_action(
            "Special focus? (e.g. warblers, shorebirds — or leave blank)",
            default="",
        ),
        # 4. Save it
        set_variable_action("Focus"),

        # 5. Build JSON body string
        text_action(json_body_token),
        # 6. Save it
        set_variable_action("JSONBody"),

        # 7. POST to GitHub
        http_post_action(
            url=dispatch_url,
            headers={
                "Authorization":       f"Bearer {pat}",
                "Accept":              "application/vnd.github+json",
                "Content-Type":        "application/json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            body_variable="JSONBody",
        ),

        # 8. Confirm to user
        show_result_action(
            "Report requested! Check your email in about 5 minutes."
        ),
    ]


# ---------------------------------------------------------------------------
# Assemble and write the .shortcut file (XML plist — iOS accepts both)
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/generate-shortcut.py YOUR_GITHUB_PAT")
        print()
        print("Get a PAT at: https://github.com/settings/tokens/new")
        print("Required scope: workflow")
        sys.exit(1)

    pat = sys.argv[1].strip()

    shortcut = {
        "WFWorkflowActions":              build_actions(pat),
        "WFWorkflowClientVersion":        "2600.0.57",
        "WFWorkflowHasShortcutInputVariables": False,
        "WFWorkflowIcon": {
            # Glyphs are internal Apple IDs; 59511 ≈ binoculars / search
            "WFWorkflowIconGlyphNumber":  59511,
            # Color: dark green (ARGB as signed 32-bit int)
            "WFWorkflowIconStartColor":   2071128575,
        },
        "WFWorkflowImportQuestions":      [],
        "WFWorkflowInputContentItemClasses": [],
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowName":                 "Bird Report",
        "WFWorkflowNoInputBehavior": {
            "Name":       "WFWorkflowNoInputBehaviorAskForInput",
            "Parameters": {},
        },
        "WFWorkflowOutputContentItemClasses": [],
        "WFWorkflowTypes":                [],
    }

    out_path = "BirdReport.shortcut"
    with open(out_path, "wb") as f:
        plistlib.dump(shortcut, f, fmt=plistlib.FMT_XML)

    print(f"✓  Written: {out_path}")
    print()
    print("Next steps:")
    print("  1. AirDrop BirdReport.shortcut to your iPhone")
    print("     (or open via Files app / iCloud Drive)")
    print("  2. Tap it on iPhone → 'Add Shortcut'")
    print("  3. Long-press the shortcut → 'Add to Home Screen'")
    print("  4. Say 'Hey Siri, Bird Report' to trigger from anywhere")


if __name__ == "__main__":
    main()
