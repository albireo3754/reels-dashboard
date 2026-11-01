export interface BlogAnnotation {
  id: string;
  paragraphId: string;
  quote: string;
  context: string;
  note: string;
  checked: boolean;
  createdAt: string;
  fresh?: boolean;
}
