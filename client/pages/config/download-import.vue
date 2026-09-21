<template>
  <div>
    <app-settings-content :header-text="$strings.HeaderDownloadImportQueue" :description="$strings.LabelDownloadImportEnabledHelp">
      <div class="flex items-center gap-2 mb-4">
        <span class="material-symbols text-lg" :class="statusInfo.enabled ? 'text-success' : 'text-gray-300'">{{ statusInfo.enabled ? 'play_circle' : 'pause_circle' }}</span>
        <p class="text-sm text-gray-200">
          <template v-if="statusInfo.enabled">{{ $strings.LabelDownloadImportEnabled }} — {{ watchRootsLabel }}</template>
          <template v-else>{{ $strings.LabelDownloadImportEnabled }}</template>
        </p>
      </div>

      <div v-if="!sortedRows.length" class="flex justify-center text-center py-8">
        <p class="text-lg text-gray-200">{{ $strings.MessageDownloadImportQueueEmpty }}</p>
      </div>

      <div v-for="row in sortedRows" :key="row.id" class="mb-3 bg-primary/10 rounded-md px-4 py-3">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-xs font-semibold uppercase rounded-sm px-1.5 py-0.5" :class="statusClass(row.status)">{{ humanStatus(row.status) }}</span>
          <p class="text-base font-semibold">{{ row.releaseName }}</p>
          <span v-if="row.confidence !== null && row.confidence !== undefined" class="text-sm text-gray-300">{{ confidencePct(row.confidence) }}</span>
        </div>

        <p class="text-sm text-gray-400 truncate" :title="row.sourcePath">{{ row.sourcePath }}</p>

        <p v-if="row.status === STATUS_ERROR && (row.errorStage || row.errorReason)" class="text-sm text-error mt-1">
          {{ row.errorStage }}: {{ row.errorReason }}
        </p>

        <div class="flex items-center gap-2 mt-3">
          <ui-btn v-if="canRetry(row)" small color="bg-primary" :loading="row._busy" @click="retryItem(row)">{{ $strings.ButtonDownloadImportRetry }}</ui-btn>
          <ui-btn v-if="canDismiss(row)" small color="bg-gray-500" :loading="row._busy" @click="dismissItem(row)">{{ $strings.ButtonDownloadImportDismiss }}</ui-btn>
        </div>

        <div v-if="row.status === STATUS_MATCH_REVIEW" class="mt-3 border-t border-white/10 pt-3">
          <div class="flex items-end gap-2 flex-wrap mb-3">
            <ui-text-input-with-label v-model="refineForms[row.id].title" :label="$strings.LabelSearchTitle" class="flex-grow min-w-[192px]" />
            <ui-text-input-with-label v-model="refineForms[row.id].author" :label="$strings.LabelAuthor" class="flex-grow min-w-[192px]" />
            <ui-btn small color="bg-primary" :loading="row._busy" @click="refineSearch(row)">{{ $strings.ButtonSearch }}</ui-btn>
          </div>

          <div class="flex items-end gap-2 flex-wrap mb-3">
            <ui-text-input-with-label v-model="asinForms[row.id]" :label="$strings.LabelSearchTitleOrASIN" class="w-64" />
            <ui-btn small color="bg-primary" :loading="row._busy" @click="pickByAsin(row)">{{ $strings.ButtonDownloadImportPick }}</ui-btn>
          </div>

          <p class="text-sm text-gray-300 mb-2">{{ $strings.LabelMatchConfidence }}</p>
          <div v-if="!candidates(row).length" class="text-sm text-gray-400">{{ $strings.MessageDownloadImportNoCandidates }}</div>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            <div v-for="(candidate, index) in candidates(row)" :key="candidate.asin || index" class="flex bg-primary/20 rounded-md p-2">
              <img v-if="candidate.cover" :src="candidate.cover" class="h-20 w-14 object-cover rounded-sm" />
              <div class="flex-grow px-2 min-w-0">
                <p class="text-sm font-semibold truncate">{{ candidate.title }}</p>
                <p class="text-sm text-gray-300 truncate">{{ candidate.author }}</p>
                <p class="text-xs text-gray-400">
                  <template v-if="candidate.publishedYear">{{ candidate.publishedYear }} · </template>
                  <template v-if="candidate.durationMinutes">{{ Math.round(candidate.durationMinutes / 60) }}h · </template>
                  {{ confidencePct(candidate.matchConfidence) }}
                </p>
              </div>
              <div class="flex items-center">
                <ui-btn small color="bg-success" :loading="row._busy" @click="pickCandidate(row, candidate)">{{ $strings.ButtonDownloadImportPick }}</ui-btn>
              </div>
            </div>
          </div>
        </div>
      </div>
    </app-settings-content>
  </div>
</template>

<script>
const STATUS_ORDER = {
  match_review: 0,
  error: 1,
  importing: 2,
  normalizing: 3,
  identifying: 4,
  qualifying: 5,
  detected: 6,
  parked: 7,
  skipped: 8,
  imported: 9
}

export default {
  asyncData({ store, redirect }) {
    if (!store.getters['user/getIsAdminOrUp']) {
      redirect('/')
    }
  },
  data() {
    return {
      statusInfo: {
        enabled: false,
        libraries: []
      },
      queueRows: [],
      refineForms: {},
      asinForms: {},
      loading: false,
      STATUS_MATCH_REVIEW: 'match_review',
      STATUS_ERROR: 'error'
    }
  },
  computed: {
    sortedRows() {
      return [...this.queueRows].sort((a, b) => {
        const order = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99)
        if (order !== 0) return order
        return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
      })
    },
    watchRootsLabel() {
      const roots = this.statusInfo.libraries.reduce((count, lib) => count + (lib.watchRoots?.length || 0), 0)
      return `${this.statusInfo.libraries.length} ${this.statusInfo.libraries.length === 1 ? 'library' : 'libraries'} · ${roots} ${roots === 1 ? 'root' : 'roots'}`
    }
  },
  methods: {
    async init() {
      this.loading = true
      const [statusResponse, queueResponse] = await Promise.all([
        this.$axios.$get('/api/download-import/status').catch((error) => {
          console.error('Failed to load download-import status', error)
          return null
        }),
        this.$axios.$get('/api/download-import/queue').catch((error) => {
          console.error('Failed to load download-import queue', error)
          return null
        })
      ])
      this.loading = false
      if (statusResponse) this.statusInfo = statusResponse
      if (queueResponse) this.setQueue(queueResponse.queue)
    },
    setQueue(rows) {
      this.queueRows = rows || []
      for (const row of this.queueRows) {
        this.ensureRowForms(row)
      }
    },
    ensureRowForms(row) {
      if (!this.refineForms[row.id]) {
        this.$set(this.refineForms, row.id, {
          title: row.matchData?.searchTitle || row.parsedMetadata?.title || '',
          author: row.matchData?.searchAuthor || row.parsedMetadata?.author || ''
        })
      }
      if (this.asinForms[row.id] === undefined) {
        this.$set(this.asinForms, row.id, '')
      }
    },
    queueUpdated(row) {
      if (!row?.id) return
      const index = this.queueRows.findIndex((r) => r.id === row.id)
      if (index >= 0) {
        row._busy = this.queueRows[index]._busy
        this.queueRows.splice(index, 1, row)
      } else {
        this.queueRows.push(row)
      }
      this.ensureRowForms(row)
    },
    humanStatus(status) {
      return String(status || '').replace(/_/g, ' ')
    },
    statusClass(status) {
      switch (status) {
        case 'match_review':
          return 'bg-warning/80 text-black'
        case 'error':
          return 'bg-error/80 text-white'
        case 'imported':
          return 'bg-success/80 text-white'
        case 'parked':
        case 'skipped':
          return 'bg-gray-600 text-white'
        default:
          return 'bg-primary/60 text-white'
      }
    },
    confidencePct(confidence) {
      if (confidence === null || confidence === undefined) return ''
      return `${Math.round(confidence * 100)}%`
    },
    candidates(row) {
      return row.matchData?.candidates || []
    },
    canRetry(row) {
      return ['error', 'parked', 'skipped'].includes(row.status)
    },
    canDismiss(row) {
      return ['match_review', 'error', 'parked', 'skipped'].includes(row.status)
    },
    async queueAction(row, path, body, successToast) {
      if (row._busy) return
      this.$set(row, '_busy', true)
      try {
        const response = await this.$axios.$post(path, body || {})
        if (response?.queueItem) this.queueUpdated(response.queueItem)
        if (successToast) this.$toast.success(successToast)
      } catch (error) {
        console.error('Download import queue action failed', error)
        this.$toast.error(error.response?.data?.error || this.$strings.ToastDownloadImportActionFailed)
      } finally {
        this.$set(row, '_busy', false)
      }
    },
    retryItem(row) {
      this.queueAction(row, `/api/download-import/queue/${row.id}/retry`, {}, this.$strings.ToastDownloadImportRetrySuccess)
    },
    dismissItem(row) {
      this.queueAction(row, `/api/download-import/queue/${row.id}/dismiss`, {})
    },
    pickCandidate(row, candidate) {
      this.queueAction(row, `/api/download-import/queue/${row.id}/match`, { candidate }, this.$strings.ToastDownloadImportMatchSuccess)
    },
    pickByAsin(row) {
      const asin = (this.asinForms[row.id] || '').trim()
      if (!asin) return
      this.queueAction(row, `/api/download-import/queue/${row.id}/match`, { asin }, this.$strings.ToastDownloadImportMatchSuccess)
    },
    refineSearch(row) {
      const form = this.refineForms[row.id] || {}
      const title = (form.title || '').trim()
      const author = (form.author || '').trim()
      if (!title && !author) return
      this.queueAction(row, `/api/download-import/queue/${row.id}/search`, { title, author })
    }
  },
  mounted() {
    this.init()
    this.$root.socket.on('download_import_queue_updated', this.queueUpdated)
  },
  beforeDestroy() {
    this.$root.socket.off('download_import_queue_updated', this.queueUpdated)
  }
}
</script>
