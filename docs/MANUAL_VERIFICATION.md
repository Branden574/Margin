# Manual browser verification

Observed on October 1, 2026 in the actual Codex in-app browser at `https://127.0.0.1:5173/`. This record deliberately separates a visible walkthrough from the automated test suite. It does not claim everything has been tested manually.

| Area                            | Manual status                    | Evidence or next step                                                                                                                                                                   |
| ------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial HTTPS access            | Passed                           | The actual in-app browser loaded “Margin · Your workspace” and the “Create private workspace” form with normal certificate validation. No warning bypass or browser exception was used. |
| Create/unlock vault             | User handoff                     | The user must create the passphrase in the browser. The agent has not entered or created this credential.                                                                               |
| Library and folders             | Pending                          | Check import, blank creation, search, sorting, rename/copy, star, folder moves, templates, Trash and restore using disposable documents.                                                |
| PDF editing                     | Pending                          | Check visible rendering, annotation tools, comments, selection, undo/redo, search, thumbnails and page navigation.                                                                      |
| Save and recovery               | Pending                          | Verify save indicators, reload/unlock persistence, unfinished-draft navigation, and multiple-tab locking.                                                                               |
| PDF page operations and exports | Pending                          | Check rotate, duplicate, insert, move, delete, merge, extraction and encrypted export/re-import.                                                                                        |
| Settings and local assignments  | Pending                          | Check each theme, preferences, navigation, assignment draft/status/submission/feedback and persistence.                                                                                 |
| Mobile layout                   | Pending                          | Walk through narrow-viewport navigation, dialogs and editor controls.                                                                                                                   |
| Offline and optional local API  | Automated evidence only          | Separate test fixtures passed; an actual manual offline/upload walkthrough has not been completed.                                                                                      |
| Native Chrome extension         | Not manually installed or tested | Packaging and URL tests pass; the default now matches the app origin.                                                                                                                   |

The first preview handoff failed because automated browser tests handled the development certificate differently from the user's browser. The corrected certificate is a server-only leaf naming exactly `127.0.0.1`; the exact public certificate receives user-account SSL trust. Native macOS checks reject `localhost`, `::1` and unrelated hostnames. The browser was then visibly verified at the correct origin.

A screenshot of that successful initial page is saved locally under `.local/manual-checks/preview-working.jpg` (Git-ignored). Do not mistake the initial page screenshot for evidence that the remaining rows passed.

Use the same exact origin throughout: different hostnames or ports have separate encrypted browser vaults. No cloud collaboration, identity, OCR, LMS delivery, production security certification or school hardware testing is implied by this record.
