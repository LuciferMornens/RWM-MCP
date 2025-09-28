export type ID = string; // e.g., "T-142", "D-981", "P-7f3a"

export type EventKind = "DECISION" | "ASSUMPTION" | "BLOCKER" | "FIX" | "TEST_FAIL" | "TEST_PASS" | "NOTE";

export interface Task {
  id: ID; parent_id?: ID | null; session_id: string;
  title: string; status: "todo" | "doing" | "done" | "blocked";
  accept_criteria?: string | null; created_at: string; updated_at: string;
}

export interface Edge { src_id: ID; dst_id: ID; kind: "depends_on" | "relates_to" | "touches"; }

export interface Event {
  id: ID; kind: EventKind; task_id?: ID | null; session_id: string;
  summary: string; evidence_ids?: ID[]; ts: string;
}

export interface ArtifactMeta {
  id: ID; // e.g., P-<hash prefix> or Snip-<hash>
  kind: "DIFF" | "SNIPPET" | "CONFIG" | "FIXTURE" | "TEST_TRACE" | "LOG" | "OTHER";
  uri: string;   // artifact://sha256/<hash> or workspace://path#L..R
  sha256: string; size: number; meta_json?: any; created_at: string;
}

export interface Fact { id: ID; key: string; value: string; scope: "repo" | "service" | "team" | "global"; }

export interface Checkpoint { id: ID; session_id: string; label: string; ts: string; bundle_meta?: any; }

export interface StateFrameInput {
  session_id: string;
  task?: string;
  decisions?: { id?: ID; type: "DECISION" | "ASSUMPTION" | "FIX" | "BLOCKER" | "NOTE"; summary: string; evidence?: ID[] }[];
  artifacts?: { id?: ID; kind: ArtifactMeta["kind"]; uri?: string; text?: string; path?: string; startLine?: number; endLine?: number; meta?: any }[];
  next_actions?: string[];
  facts?: { key: string; value: string; scope?: Fact["scope"] }[];
}