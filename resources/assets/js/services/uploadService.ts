import { without } from 'lodash'
import { reactive } from 'vue'
import { http } from '@/services/http'
import { postWithProgress } from '@/services/http'
import { albumStore } from '@/stores/albumStore'
import { commonStore } from '@/stores/commonStore'
import { playableStore } from '@/stores/playableStore'
import { eventBus } from '@/utils/eventBus'
import { logger } from '@/utils/logger'

export interface UploadResult {
  song: Song
  album: Album
}

export type UploadStatus = 'Ready' | 'Uploading' | 'Uploaded' | 'Canceled' | 'Errored'

export interface UploadFile {
  id: string
  file: File
  status: UploadStatus
  name: string
  progress: number
  message?: string
}

export interface DuplicateUpload {
  id: string
  type: string
  filename: string
}

export const uploadService = {
  state: reactive({
    files: [] as UploadFile[],
    duplicateFilesUploaded: false,
    duplicatedSongs: [] as DuplicateUpload[],
  }),

  simultaneousUploads: 5,

  queue(file: UploadFile | UploadFile[]) {
    this.state.duplicateFilesUploaded = false;
    this.state.files = this.state.files.concat(file)
    this.proceed()
  },

  remove(file: UploadFile) {
    this.state.files = without(this.state.files, file)
    this.proceed()
  },

  proceed() {
    const remainingSlots = this.simultaneousUploads - this.getUploadingFiles().length

    if (remainingSlots <= 0) {
      return
    }

    for (let i = 0; i < remainingSlots; ++i) {
      const file = this.getUploadCandidate()
      file && this.upload(file)
    }
  },

  getUploadingFiles() {
    return this.state.files.filter(({ status }) => status === 'Uploading')
  },

  getUploadCandidate() {
    return this.state.files.find(({ status }) => status === 'Ready')
  },

  shouldWarnUponWindowUnload() {
    return this.state.files.length > 0
  },

  async upload(file: UploadFile) {
    if (file.status === 'Uploading') {
      return
    }

    const formData = new FormData()
    formData.append('file', file.file)
    file.progress = 0
    file.status = 'Uploading'

    try {
      const result = await postWithProgress<UploadResult | null>('upload', formData, (e: ProgressEvent) => {
        file.progress = (e.loaded * 100) / e.total
      })

      if (result?.song && result?.album) {
        file.status = 'Uploaded'
        this.handleUploadResult(result)
        window.setTimeout(() => this.remove(file), 1000)
      } else {
        file.status = 'Errored'
        file.message = 'Upload failed: Server returned an unexpected response.'
      }

      this.proceed()
    } catch (error: unknown) {
      logger.error(error)
      file.status = 'Errored'

      if (error instanceof Error && 'status' in error) {
        const status = (error as any).status

        if (status === 409) {
          file.message = 'Duplicate file uploaded.'
          console.log('Duplicate File uploaded')
          this.state.duplicateFilesUploaded = true;
          this.proceed()
          return
        }
      }

      if (error instanceof Error && 'responseData' in error && (error as any).responseData?.message) {
        file.message = `Upload failed: ${(error as any).responseData.message}`
      } else {
        file.message = 'Upload failed: Unknown error.'
      }

      this.proceed() // upload the next file
    }
  },

  async fetchDuplicates() {
    const response = await http.get<{data: DuplicateUpload[]}>('duplicate-uploads')
    this.state.duplicatedSongs = response.data
    console.log(this.state.duplicatedSongs)
    return this.state.duplicatedSongs;    
  },

  handleUploadResult: (result: UploadResult) => {
    playableStore.syncWithVault(result.song)
    albumStore.syncWithVault(result.album)
    commonStore.state.song_length += 1
    eventBus.emit('SONG_UPLOADED', result.song)
  },

  retry(file: UploadFile) {
    // simply reset the status and wait for the next process
    this.resetFile(file)
    this.proceed()
  },

  retryAll() {
    this.state.files.forEach(this.resetFile)
    this.proceed()
  },

  resetFile: (file: UploadFile) => {
    file.status = 'Ready'
    file.progress = 0
  },

  removeFailed() {
    this.state.files = this.state.files.filter(({ status }) => status !== 'Errored')
  },
}
