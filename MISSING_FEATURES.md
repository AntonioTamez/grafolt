# Missing features

Capabilities that comparable local-first note apps commonly offer and that Grafolt does not implement yet. Use it as a backlog and a map of the gap, not as a promise.

**Effort** is a rough estimate by the author of this file: **S** is hours, **M** is days, **L** is weeks or a redesign. It is not measured.

## What Grafolt already covers

Plain-folder vaults, wikilinks (`[[Note]]`, alias, `#heading`), backlinks, an interactive graph (drag, pan, zoom, hover highlight), creating notes (`Untitled` naming, `newFileLocation`, `Ctrl+N`), renaming and moving notes with link rewriting, live updates from external edits, callouts, task checkboxes (read-only), tags (parsed, not browsable), a desktop app and a Windows installer. See the [README](README.md) for details.

## Editor

| Capability | Effort |
|---|---|
| Live preview: edit with formatting rendered inline, plus a source and reading mode switch | L |
| Link autocomplete when typing `[[` | M |
| Formatting commands: bold, italics, strikethrough, highlight, inline code, inline math, comments | S |
| List and block commands: bullet, numbered, checklist, blockquote, indent and unindent, cycle checklist state | S |
| Insert helpers: callout, code block, table, footnote, math block, horizontal rule, embed, link, wikilink, tag | S |
| Heading levels, and renaming a heading while updating the links to it | M |
| Fold and unfold headings and lists | M |
| Move a line up or down, delete a paragraph, multiple cursors | M |
| Find and replace inside a note | S |
| Vim key bindings | M |
| Editor options: line numbers, readable line length, strict line breaks, spellcheck toggle and languages (spellcheck is currently always off) | S |
| Slash commands | M |
| Attach files to a note, download remote attachments, and a configurable attachment folder | M |
| Follow a link and open it in a new tab, split or window | M |

## Markdown rendering

| Capability | Effort |
|---|---|
| Tables | M |
| Footnotes and a footnotes pane | M |
| Math (LaTeX) | M |
| Diagrams (Mermaid) | M |
| Syntax highlighting in code blocks | S |
| Embeds of notes, images, PDFs, audio and video (`![[...]]`) | L |
| Links to headings and blocks, including in the same note (`[[#Heading]]`, `^block-id`), that navigate to the target | M |
| Foldable callouts and callout icons | S |
| Comments that do not render | S |
| Nested lists and nested blockquotes | S |
| Interactive task checkboxes (toggle from the preview) | S |
| Internal Markdown links (`[text](note.md)`) and a setting to choose the link style | M |
| YAML frontmatter and typed properties (frontmatter is currently skipped, so links inside it are ignored) | L |

## Navigation and search

| Capability | Effort |
|---|---|
| Quick switcher (fuzzy open, create from the box) | M |
| Command palette | M |
| Vault-wide search with operators | L |
| Tag pane (browse notes by tag) | M |
| Outline of the current note | S |
| Outgoing links panel and unlinked mentions | M |
| Back and forward navigation history | S |
| Bookmarks (notes, headings, searches) | M |
| Random note | S |
| Hover preview of a linked note | M |
| Excluded files and folders | S |

## File management

| Capability | Effort |
|---|---|
| Folder tree in the sidebar (Grafolt shows a flat list of paths) | M |
| New folder, move file, duplicate file from the UI | S |
| Delete from the UI with a confirmation and a trash (Grafolt has the API but no button, and deletes permanently) | S |
| Drag and drop to move notes | M |
| Copy path, copy URL | S |
| Edit the note title inline | S |
| Choose how links are written (shortest, relative, absolute) and whether links update automatically (Grafolt always asks and uses the shortest form) | S |
| File recovery: snapshots of older versions | L |
| Merge two notes, split a note, extract a heading into a new note | M |

## Graph

| Capability | Effort |
|---|---|
| Local graph (neighbours of the open note) | M |
| Settings panel for forces, filters, groups and display options | M |
| Animate the graph over time | M |
| Tags, attachments and orphans as optional nodes, and filters | M |
| Simulation in a worker so very large vaults stay smooth | M |
| Graph that updates live while it is open | S |

## Workspace and layout

| Capability | Effort |
|---|---|
| Tabs: new, next, previous, go to, pin, close variants, reopen closed | L |
| Split panes horizontally and vertically, stacked tabs | L |
| New window and moving a tab to a window | M |
| Collapsible sidebars | S |
| Saved workspace layouts | M |
| Remembering the open notes and layout between sessions | M |
| Status bar with word count and editor status | S |

## Settings, appearance and extensibility

| Capability | Effort |
|---|---|
| Settings screen (Grafolt is configured by editing `.grafolt/app.json`) | M |
| Custom hotkeys | M |
| Themes, a light and dark toggle, and CSS snippets (Grafolt only follows the OS theme) | M |
| Features that can be switched on and off individually | L |
| A plugin system and API for third-party extensions | L |
| A vault manager with a list of known vaults (Grafolt opens one vault at a time through **Vault > Open vault**) | M |
| Interface translations | M |
| In-app help and a sample vault for onboarding (a small sample vault exists in the repository but is not opened by the app) | M |

## Note workflows

| Capability | Effort |
|---|---|
| Daily notes with next and previous navigation | M |
| Templates | M |
| Unique note prefixes (Zettelkasten-style IDs) | S |
| Slides from a note | M |
| Audio recorder | M |
| Importers from other note apps | L |

## Structured and visual notes

| Capability | Effort |
|---|---|
| Canvas: free-form boards with cards and links | L |
| Database-style views of notes and their properties | L |
| Web viewer: browse the web inside the app, reader mode, save pages to the vault | L |

## Export, integration and platform

| Capability | Effort |
|---|---|
| Export a note to PDF and print | M |
| Command-line interface and links that open a note from outside the app | M |
| Auto-update of the app (the Grafolt installer is manual) | M |
| Cross-platform builds and signed installers (Grafolt ships an unsigned Windows x64 installer only) | M |

## Services and out of scope

These are services or product areas rather than app features. Listing them keeps the gap honest; they are unlikely to belong in a local-first project.

| Capability |
|---|
| End-to-end encrypted sync across devices, with version history and a sync log |
| Publishing notes as a website |
| Mobile apps |

## Under the hood

Differences in how mature note apps are built that explain some of the gaps above.

- **Persistent metadata cache.** Parsed indexes can be kept between sessions. Grafolt re-reads and re-parses the whole vault on every start.
- **Parsing off the main thread.** Grafolt parses on the main thread, and link resolution re-scans the vault on each change, which will not scale to very large vaults.
- **Incremental link updates.** Grafolt recomputes all links after each change instead of only the affected references.
- **Link parsing scope.** Grafolt does not read links inside YAML frontmatter, so they are neither shown nor rewritten on rename.

## Suggested order

A starting point, ranked by user value against effort. Reorder freely.

1. Link autocomplete on `[[`, and a quick switcher.
2. Delete from the UI with a trash, new folder and move.
3. Rendering gaps: tables, footnotes, math, syntax highlighting, foldable callouts, nested lists.
4. Heading and block links that navigate, plus an outline panel.
5. Tag pane, outgoing links and unlinked mentions.
6. Vault-wide search.
7. Settings screen, hotkeys and a theme toggle.
8. Daily notes and templates.
9. Tabs and split panes.
