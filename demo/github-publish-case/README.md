# GitHub publish acceptance case

This tiny project intentionally starts with one failing test. Select the
**repository root** in PocketPilot, then analyze the traceback in this folder.
The phone may approve a one-file fix after reviewing its diff and the local
pytest result. A separate request on the phone and confirmation on the laptop
are required before a commit is pushed to GitHub.

The committed fix is the acceptance evidence, so this example is not designed
to be undone after a successful publish.
