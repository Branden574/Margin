export type FormValue = string | boolean | string[];
export interface PdfFormField {
  name: string;
  label: string;
  kind: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'list';
  value: FormValue;
  readOnly: boolean;
  required: boolean;
  multiline?: boolean;
  maxLength?: number;
  options?: string[];
  multiselect?: boolean;
  allowClear?: boolean;
}
export interface PdfFormInspection {
  fields: PdfFormField[];
}
export interface PdfFormChange {
  name: string;
  value: FormValue;
}
