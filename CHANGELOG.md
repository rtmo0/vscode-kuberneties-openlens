# Changelog

All notable changes to this extension are documented in this file.

## 1.3.2 - 2026-10-28

### Added

- **Connect** and **Disconnect** buttons on cluster rows in the tree (also in the context menu and Command Palette). Disconnect closes the cluster's panels, stops its port forwards and watches, and keeps it offline until you connect again.

## 1.3.1 - 2026-10-16

### Changed

- The **Sponsor** button and README support link now point to Boosty instead of Buy Me a Coffee.

## 1.3.0 - 2026-10-16

### Added

- A **Sponsor** button (Buy Me a Coffee) on the extension page in VS Code and the Marketplace, and a Support section in the README.

## 0.4.0 - 2026-10-16

### Fixed

- Details open at once with what the object itself contains (overview, containers, conditions, volumes, labels); metrics, events, pods and rollout history follow. The cluster `/version` check no longer delays them, and metrics, events, permissions and rollout history load in parallel (pod details on a slow VPN: first content in ~0.6 s and everything in ~1.9 s instead of ~13 s).
- Probe the well-known Prometheus services in parallel instead of one after another (about 9 s on clusters without Prometheus), and show metrics-server data until detection finishes.
- Record a details view as recently opened once per open, not on every refresh.

## 0.3.0 - 2026-10-16

### Added

- Resource table columns can be resized by dragging the header edge; double-click fits the widest value on the page. Widths are kept per resource kind.

### Fixed

- Keep a visible loading indicator while resource tabs open, refresh, or switch namespaces; clear it on errors and unchanged responses.
- Start resource lists with a small 100-item page, then load the remaining resources in consistent 500-item server-side pages.
- Show resource rows before action permission checks and metrics finish, and load the namespace selector independently.
- Preserve early webview responses until the client is ready and immediately retry refreshes requested during an active load instead of waiting for the polling interval.
- Bound resource tables to 100 visible rows with Previous/Next navigation; keep search, sorting and select-all across the full filtered list, coalesce incoming renders and preserve unchanged visible pages.
- Publish live updates during continuous watch traffic instead of waiting indefinitely for a quiet period; stop pending watch work when a tab is closed.
- Share a pod watch for node counts instead of repeatedly downloading all active pods, and keep slow metrics requests from delaying namespace changes.
- Request API responses gzip-compressed, like kubectl: large lists load several times faster (all pods of a ~850-pod cluster in ~1.2 s instead of ~6 s).
- Send only metric cells that changed.
- Keep showing the last complete list while a watch re-lists after 410 Gone or a reconnect, instead of shrinking the table to its first page.
- Running job durations tick live; completed ones use the same format as ages (e.g. `3h12m`).
- Check row action permissions with one SelfSubjectRulesReview per namespace (a few namespaces at a time) instead of one SelfSubjectAccessReview per action; cluster-scoped checks and servers with incomplete rules still use access reviews (~850-pod cluster: 67 requests in ~1.8 s instead of 402 in ~7 s).
- Send resource tables to the webview once, then only added, changed and removed rows; rows of unchanged objects are not rebuilt on the host and their DOM rows are reused.

### Changed

- Pod CPU and Memory columns use the same format as nodes: percentage with a usage bar and absolute values in the tooltip, relative to the pod limit (or request when no limit is set). Pods without requests or limits show absolute usage.

## 0.2.0 - 2026-10-16

### Added

- Add Cluster wizard and a "Get started with Kubernetes" walkthrough.
- Local clusters with kind, k3d and minikube (create and delete), with tool installation through Homebrew.
- Managed clusters from Yandex Cloud, Amazon EKS, Google GKE and Azure AKS through their CLIs.
- k3s installation on your own servers over SSH, with worker nodes.
- Add-on catalog: metrics-server, ingress-nginx, cert-manager with Let's Encrypt issuers, Prometheus + Grafana, Loki + Promtail, Sealed Secrets, Argo CD, ExternalDNS, Local Path Provisioner.
- Helm chart installation from Artifact Hub with schema-aware values editing; Helm repository management.
- Cluster Doctor with fixes.
- Team onboarding with quotas, defaults, isolation and a service-account kubeconfig; kubeconfigs for existing service accounts.
- Image pull, TLS, .env and file-based Secrets and ConfigMaps.
- Deploy an Image form and docker-compose conversion.
- Manifest completion and validation against the cluster's schema (with the Red Hat YAML extension).

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
