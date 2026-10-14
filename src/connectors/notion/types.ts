export interface NotionRichText {
  plain_text?: string;
  href?: string | null;
}

export interface NotionProperty {
  id?: string;
  type?: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  status?: { id?: string; name?: string; color?: string } | null;
  select?: { id?: string; name?: string; color?: string } | null;
  multi_select?: Array<{ id?: string; name?: string; color?: string }>;
  people?: Array<{ id?: string; name?: string; person?: { email?: string } }>;
  date?: { start?: string; end?: string | null; time_zone?: string | null } | null;
  relation?: Array<{ id: string }>;
  checkbox?: boolean;
  number?: number | null;
  url?: string | null;
  email?: string | null;
  phone_number?: string | null;
  formula?: { type?: string; string?: string | null; number?: number | null; boolean?: boolean | null; date?: { start?: string } | null };
}

export interface NotionPage {
  object: "page";
  id: string;
  created_time: string;
  last_edited_time: string;
  url: string;
  archived?: boolean;
  in_trash?: boolean;
  parent?: {
    type?: string;
    page_id?: string;
    data_source_id?: string;
    database_id?: string;
    workspace?: boolean;
  };
  properties: Record<string, NotionProperty>;
}

export interface NotionBlock {
  object: "block";
  id: string;
  type: string;
  has_children: boolean;
  archived?: boolean;
  in_trash?: boolean;
  [key: string]: unknown;
}

export interface NotionListResponse<T> {
  object: "list";
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
}
