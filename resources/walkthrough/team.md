## Onboard a team

Creates in one step:

- a namespace with a ResourceQuota and default container requests / limits,
- an optional NetworkPolicy that isolates it,
- a ServiceAccount bound to `view`, `edit` or `admin`,
- a kubeconfig with a token (30 days, 1 year or non-expiring) to send to the team.

Service accounts that already exist get a **Kubeconfig** action in their table.
