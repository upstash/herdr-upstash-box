# Architecture decision records

One page per decision that a future reader might reasonably want to reverse. Each records what was decided, why, and what it rules out. Superseding a decision means a new page that names the old one, not an edit.

| ADR                                  | Decision                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| [0001](0001-provider-credentials.md) | Which provider credential a session uses, and what never happens silently                        |
| [0002](0002-remove-native-mode.md)   | Native mode, typed runs, and schedules are removed; the agent always runs in its own terminal UI |
