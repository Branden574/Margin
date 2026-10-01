export type CoverStyle = 'biology' | 'literature' | 'math' | 'notes' | 'blank' | 'import';
export interface DocumentRecord {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  pageCount: number;
  createdAt: number;
  updatedAt: number;
  folderId: string | null;
  starred: boolean;
  trashed: boolean;
  cover: CoverStyle;
  source: 'sample' | 'upload' | 'created';
}
export interface FolderRecord {
  id: string;
  name: string;
  color: string;
}
export type AnnotationTool =
  | 'select'
  | 'text'
  | 'pen'
  | 'highlight'
  | 'eraser'
  | 'comment'
  | 'rectangle'
  | 'ellipse'
  | 'line'
  | 'arrow';
export interface Point {
  x: number;
  y: number;
  pressure?: number;
}
export interface Annotation {
  id: string;
  pageIndex: number;
  type:
    | 'text'
    | 'pen'
    | 'highlight'
    | 'comment'
    | 'rectangle'
    | 'ellipse'
    | 'line'
    | 'arrow'
    | 'signature'
    | 'stamp';
  x: number;
  y: number;
  width?: number;
  height?: number;
  points?: Point[];
  strokes?: Point[][];
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  fontSize?: number;
  text?: string;
  color: string;
  strokeWidth: number;
  opacity: number;
  createdAt: number;
  author: string;
  rotation?: number;
}
export interface AnnotationOperation {
  id: string;
  documentId: string;
  timestamp: number;
  kind: 'put' | 'delete';
  annotationId: string;
  annotation?: Annotation;
}
export interface UploadRecord {
  id: string;
  name: string;
  size: number;
  progress: number;
  status: 'queued' | 'uploading' | 'paused' | 'processing' | 'complete' | 'cancelled' | 'error';
  error?: string;
  documentId?: string;
}
export interface Assignment {
  id: string;
  title: string;
  instructions: string;
  documentId: string;
  dueDate: string;
  className: string;
  status: 'draft' | 'assigned' | 'submitted' | 'returned';
  createdAt: number;
  feedback?: string;
}
export interface Preferences {
  name: string;
  role: 'teacher' | 'student';
  theme: 'light' | 'dark' | 'contrast';
  dyslexiaFont: boolean;
  reducedMotion: boolean;
  shortcuts: boolean;
}
