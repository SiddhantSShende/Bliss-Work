{{/*
_helpers.tpl — name and label helpers shared by every template.
*/}}

{{/*
Chart name (overridable via --set nameOverride).
*/}}
{{- define "taskboard.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully-qualified release name. Used as the base for per-service resource names.
*/}}
{{- define "taskboard.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Chart label "name-version".
*/}}
{{- define "taskboard.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels applied to every object.
*/}}
{{- define "taskboard.labels" -}}
helm.sh/chart: {{ include "taskboard.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: taskboard
{{ include "taskboard.commonSelectorLabels" . }}
{{- end -}}

{{/*
Common selector labels (instance + the part-of grouping). Per-service templates
ADD app.kubernetes.io/name and app.kubernetes.io/component on top of these.
*/}}
{{- define "taskboard.commonSelectorLabels" -}}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Per-service selector labels. Call with a dict: (dict "root" $ "svc" $name).
These are the labels a Service / HPA / PDB selects on, and the pod template
labels a Deployment sets — they MUST match exactly.
*/}}
{{- define "taskboard.svcSelectorLabels" -}}
app.kubernetes.io/name: {{ .svc }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end -}}

{{/*
Full label set for a single service's objects.
Call with a dict: (dict "root" $ "svc" $name).
*/}}
{{- define "taskboard.svcLabels" -}}
{{ include "taskboard.labels" .root }}
app.kubernetes.io/name: {{ .svc }}
app.kubernetes.io/component: {{ .svc }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
{{- end -}}

{{/*
Resolve a service's image. If the configured image already contains a registry
host (a "/" before any tag) or an explicit tag (":"), use it verbatim; otherwise
prepend global.image.registry and append global.image.tag.
Call with a dict: (dict "root" $ "image" $svc.image).
*/}}
{{- define "taskboard.image" -}}
{{- $img := .image -}}
{{- $reg := .root.Values.global.image.registry -}}
{{- $tag := .root.Values.global.image.tag | toString -}}
{{- if or (contains "/" $img) (contains ":" $img) -}}
{{- $img -}}
{{- else -}}
{{- printf "%s/%s:%s" $reg $img $tag -}}
{{- end -}}
{{- end -}}

{{/*
Name of the Secret services pull env from: an externally-managed one if set,
else the chart-rendered Secret.
*/}}
{{- define "taskboard.secretName" -}}
{{- if .Values.existingSecret -}}
{{- .Values.existingSecret -}}
{{- else -}}
{{- printf "%s-env" (include "taskboard.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/*
Name of the ConfigMap holding non-secret env.
*/}}
{{- define "taskboard.configMapName" -}}
{{- printf "%s-env" (include "taskboard.fullname" .) -}}
{{- end -}}

{{/*
Name of the Secret holding the Ed25519 signing keys.
*/}}
{{- define "taskboard.keysSecretName" -}}
{{- if .Values.signingKeys.existingKeysSecret -}}
{{- .Values.signingKeys.existingKeysSecret -}}
{{- else -}}
{{- printf "%s-keys" (include "taskboard.fullname" .) -}}
{{- end -}}
{{- end -}}
