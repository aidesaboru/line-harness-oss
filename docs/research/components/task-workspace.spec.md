# Task workspace retrofit

## Goal

Turn the existing internal task page into a task workspace with two interchangeable views:

- A Trello-style board for moving work between workflow lists.
- A compact list for scanning and comparing many tasks.

The task itself must be identifiable without opening the detail view.

## Evidence used

- Trello boards group cards into lists that represent stages of work.
- Trello cards expose the task title and lightweight metadata before opening details.
- Trello table view exposes card name, list, labels, members, and due date in comparable columns.
- Existing EC Owner LINE CRM visual language remains authoritative for colors, spacing, typography, and controls.

## Scope for this release

### Shared controls

- View switcher: `ボード` and `リスト`.
- Scope switcher: `自分のタスク` and `すべてのタスク`.
- Keyword search across task name, description, source context, and assignee names.
- Source filter: all, ticket, customer chat, group LINE.
- Due filter: all, overdue, due within seven days, no due date.
- Result count and overdue count.

### Board view

- Two workflow lists backed by the existing persisted status: `未完了` and `完了`.
- Cards can be dragged between lists on desktop and changed with an explicit status action in the detail panel.
- Dragging is an enhancement and never the only way to change status.
- Each list shows its card count and a useful empty state.
- Mobile stacks the lists vertically to avoid a hidden horizontal workspace.

### List view

- Desktop uses a table with task, status, source, assignee, due date, and update date columns.
- Mobile uses stacked rows with the same information hierarchy.
- Rows open the same task detail panel as board cards.

### Task identity

Every board card and list row shows, in this order:

1. Task name.
2. Description preview or an explicit `説明なし` state.
3. Concrete source context such as ticket title, customer name, or group name.
4. Status, due state, assignees, and comment count.

The worker enriches task responses with source title, customer name, and group-chat information without changing stored task data.

### Task detail

- Opens as a drawer so board and list retain their place.
- Shows the full task name, description, source context, assignees, due date, status control, source link, and comments.
- Escape and the backdrop close the drawer.
- Existing comment creation and task completion permissions remain server-enforced.

### Task creation

- Keep the existing requirement that a task is created from a source message.
- Rename `件名` to `タスク名` and `内容` to `背景・完了条件`.
- Add examples that encourage action-oriented task names instead of copying a chat sentence verbatim.

## Interaction contract

- Switching views keeps search, filters, selected account, and scope.
- Updating a task status updates the local board/list immediately after the server confirms it.
- When a filtered task no longer matches, it disappears from the current result set while the remaining view stays stable.
- Failed updates keep the original task state and show an alert.
- Opening a task lazily loads its comments once.

## Accessibility

- View and scope switchers expose `aria-pressed`.
- Board lists use headings and counts.
- Cards and rows are real buttons or contain separate real buttons without nested interactive controls.
- Drag handles have an accessible label and a visible focus state.
- Status remains changeable without dragging.
- Overdue state is written as text and is not communicated by color alone.

## Responsive behavior

- Desktop: full-width board/table with a right-side detail drawer.
- Tablet: two board columns where space permits and a full-height drawer.
- Mobile: board lists stack vertically, table becomes task rows, and the detail drawer fills the viewport.
- Long Japanese text and URLs must wrap without widening the page.

## Out of scope

- Multiple workspaces or arbitrary user-created boards.
- Arbitrary custom lists beyond the current persisted `open` and `done` states.
- Labels, custom fields, checklists, attachments, calendar/timeline/dashboard views, and automation rules.
- Persisted ordering within a list.

These are Trello capabilities but require new product and data-model decisions beyond the requested board/list visibility change.
