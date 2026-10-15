# Changelog

All notable changes to this extension are documented in this file.

## 0.1.0 - 2026-10-15

### Added

- Kubeconfig import from a file, the clipboard, the active editor or a paste editor (YAML, JSON, base64), merged into the primary kubeconfig with content-based matching, renaming of clashing clusters and users, conflict choices, relative path resolution, validation, atomic writes and backups.
- Context management: switch, rename, remove (with cleanup), default namespace, namespace filter.
- Cluster overview with CPU / memory rings and charts, workload health and warning events.
- Resource tables for workloads, config, network, storage, access control, nodes, namespaces, events, Helm releases and custom resources, with search, sort, bulk actions and live refresh.
- Details panel with containers, metrics charts, conditions, volumes, events, service ports, node usage, Helm values / manifest / history.
- Logs (multi-container, multi-pod, previous instance) and container shells in terminals.
- Port forwarding to pods and services with a Port Forwards view.
- Secret and ConfigMap editing; YAML editing with conflict detection; Apply YAML with server-side apply.
- Scale, restart, trigger / suspend / resume cronjobs, cordon / uncordon, delete, Helm uninstall.
- Live tables through the watch API.
- Protected (production) contexts that need the context name typed to confirm changes; RBAC-aware actions.
- Rollout history, revision diffs and rollback for deployments, statefulsets and daemonsets.
- Helm: diff values and manifests between revisions, rollback, edit values and upgrade.
- Node drain with PodDisruptionBudget handling, node shells, ephemeral debug containers, file copy to and from containers.
- Prometheus metric history (CPU, memory, network) with time ranges.
- Log viewer with search, level filter, JSON formatting, since, previous instance and download.
- Go to Resource, Favorites and Recent, topology view, resource templates, Diff With Live Object, dry-run preview for Apply.
- Kubeconfig folder sync, health check (expiry, missing files and plugins, reachability) with cleanup, and context export.
- Read-only Copilot Chat tools for contexts, resources, describe, logs, events and cluster overview.
- Integration tests against kind in CI.
