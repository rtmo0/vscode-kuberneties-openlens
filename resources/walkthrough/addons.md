## Add-ons

| Add-on | What for |
| --- | --- |
| metrics-server | CPU / memory usage, `kubectl top`, autoscaling |
| ingress-nginx | HTTP(S) routing from outside |
| cert-manager | Free TLS certificates from Let's Encrypt |
| Prometheus + Grafana | Metrics, dashboards, alerting |
| Loki + Promtail | Logs of every pod in one place |
| Sealed Secrets | Secrets you can commit to Git |
| Argo CD | GitOps delivery |
| ExternalDNS | DNS records for your ingresses |
| Local Path Provisioner | Storage on clusters without a storage provider |

Values are preset for local clusters; use **Edit Values & Install** to change anything. **Install Any Helm Chart** searches Artifact Hub.
