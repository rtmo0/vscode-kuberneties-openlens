import * as vscode from 'vscode';

interface Template {
  label: string;
  detail: string;
  body: string;
}

/* Starting points for "New Resource"; {{namespace}} is replaced with the current namespace filter. */
const TEMPLATES: Template[] = [
  {
    label: 'Deployment + Service',
    detail: 'A web workload with probes, resources and a ClusterIP service',
    body: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: {{namespace}}
  labels:
    app.kubernetes.io/name: my-app
spec:
  replicas: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: my-app
  template:
    metadata:
      labels:
        app.kubernetes.io/name: my-app
    spec:
      containers:
        - name: app
          image: nginx:1.27-alpine
          ports:
            - name: http
              containerPort: 80
          readinessProbe:
            httpGet:
              path: /
              port: http
          livenessProbe:
            httpGet:
              path: /
              port: http
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              memory: 128Mi
---
apiVersion: v1
kind: Service
metadata:
  name: my-app
  namespace: {{namespace}}
spec:
  selector:
    app.kubernetes.io/name: my-app
  ports:
    - name: http
      port: 80
      targetPort: http
`
  },
  {
    label: 'Ingress',
    detail: 'Routes a host to a service',
    body: `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app
  namespace: {{namespace}}
spec:
  ingressClassName: nginx
  rules:
    - host: my-app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-app
                port:
                  name: http
`
  },
  {
    label: 'StatefulSet',
    detail: 'With a headless service and a volume claim template',
    body: `apiVersion: v1
kind: Service
metadata:
  name: my-db
  namespace: {{namespace}}
spec:
  clusterIP: None
  selector:
    app.kubernetes.io/name: my-db
  ports:
    - name: db
      port: 5432
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: my-db
  namespace: {{namespace}}
spec:
  serviceName: my-db
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: my-db
  template:
    metadata:
      labels:
        app.kubernetes.io/name: my-db
    spec:
      containers:
        - name: db
          image: postgres:16-alpine
          env:
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: my-db
                  key: password
          ports:
            - name: db
              containerPort: 5432
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        resources:
          requests:
            storage: 1Gi
`
  },
  {
    label: 'DaemonSet',
    detail: 'One pod per node',
    body: `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: my-agent
  namespace: {{namespace}}
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: my-agent
  template:
    metadata:
      labels:
        app.kubernetes.io/name: my-agent
    spec:
      tolerations:
        - operator: Exists
      containers:
        - name: agent
          image: busybox:1.36
          command: [sh, -c, 'while true; do date; sleep 60; done']
`
  },
  {
    label: 'CronJob',
    detail: 'Runs a job on a schedule',
    body: `apiVersion: batch/v1
kind: CronJob
metadata:
  name: my-job
  namespace: {{namespace}}
spec:
  schedule: "0 * * * *"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: job
              image: busybox:1.36
              command: [sh, -c, 'echo hello from $(hostname)']
`
  },
  {
    label: 'Job',
    detail: 'Runs to completion once',
    body: `apiVersion: batch/v1
kind: Job
metadata:
  name: my-task
  namespace: {{namespace}}
spec:
  backoffLimit: 2
  ttlSecondsAfterFinished: 3600
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: task
          image: busybox:1.36
          command: [sh, -c, 'echo done']
`
  },
  {
    label: 'ConfigMap',
    detail: 'Key-value configuration',
    body: `apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
  namespace: {{namespace}}
data:
  LOG_LEVEL: info
  app.yaml: |
    feature: true
`
  },
  {
    label: 'Secret',
    detail: 'Opaque secret written as plain text (stringData)',
    body: `apiVersion: v1
kind: Secret
metadata:
  name: my-secret
  namespace: {{namespace}}
type: Opaque
stringData:
  username: admin
  password: change-me
`
  },
  {
    label: 'PersistentVolumeClaim',
    detail: 'Requests storage from the default storage class',
    body: `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-data
  namespace: {{namespace}}
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
`
  },
  {
    label: 'HorizontalPodAutoscaler',
    detail: 'Scales a deployment on CPU usage',
    body: `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: my-app
  namespace: {{namespace}}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-app
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
`
  },
  {
    label: 'NetworkPolicy',
    detail: 'Allow ingress only from the same namespace',
    body: `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: same-namespace-only
  namespace: {{namespace}}
spec:
  podSelector: {}
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector: {}
`
  },
  {
    label: 'ServiceAccount + Role + RoleBinding',
    detail: 'Read-only access to pods in the namespace',
    body: `apiVersion: v1
kind: ServiceAccount
metadata:
  name: pod-reader
  namespace: {{namespace}}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-reader
  namespace: {{namespace}}
rules:
  - apiGroups: [""]
    resources: [pods, pods/log]
    verbs: [get, list, watch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: pod-reader
  namespace: {{namespace}}
subjects:
  - kind: ServiceAccount
    name: pod-reader
    namespace: {{namespace}}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: pod-reader
`
  },
  {
    label: 'Namespace',
    detail: 'A new namespace',
    body: `apiVersion: v1
kind: Namespace
metadata:
  name: my-namespace
`
  }
];

export async function newResource(namespace: string): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    TEMPLATES.map((t) => ({ label: t.label, detail: t.detail, template: t })),
    { title: 'New Kubernetes resource', placeHolder: 'Choose a template — it opens in an editor; click "Apply YAML to Cluster" when ready' }
  );
  if (!picked) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument({ language: 'yaml', content: picked.template.body.replace(/\{\{namespace\}\}/g, namespace || 'default') });
  await vscode.window.showTextDocument(doc);
}
