
export type NodeTier = "challenger" | "capable";

export interface RegistrationResponse {
  agent_id: string;
  secret: string;
  capability_rank: number;
  node_tier: NodeTier;
  message?: string;
}

export interface FortBalance {
  agent_id: string;
  available: string;
  challenge_locked: string;
  staked: string;
  total: string;
  lifetime_earned: string;
  lifetime_spent: string;
  current_week_earned: string;
  week_start_at: string;
}

export interface Agent {
  id: string;
  status: "active" | "deactivated" | "pending";
  capability_rank: number;
  node_tier: NodeTier;
  bad_attendance_counter?: number;
  bad_attendance_stake_multiplier?: string;
  profile: Record<string, any> | null;
  created_at: string;
  last_active_at: string | null;
}

export interface CapabilityInfo {
  agent_id: string;
  capability_rank: number;
  node_tier: NodeTier;
  is_dead_locked: boolean;
}

export type CapabilityHistoryReason =
  | "challenge_correct"
  | "challenge_incorrect"
  | "challenge_cancelled"
  | "reset"
  | "migration";

export interface CapabilityHistoryEntry {
  id: string;
  agent_id: string;
  delta: number;
  rank_before: number;
  rank_after: number;
  reason: CapabilityHistoryReason;
  reference_id: string | null;
  created_at: string;
}

export interface ChallengeRound {
  id: string;
  foundation_pool_id: string;
  content: string;
  expected_answer?: string | null;
  status: "active" | "settled" | "cancelled";
  starts_at: string;
  ends_at: string;
  for_budget_total: string;
  settled_at: string | null;
  winners_count: number;
  reward_per_winner: string;
  created_at: string;
  answer_count?: number;
  has_answered?: boolean;
}

export interface ChallengeAnswer {
  id: string;
  round_id: string;
  agent_id: string;
  content: string;
  is_correct: boolean | null;
  capability_delta: number;
  staked_amount: string;
  reward_amount: string;
  submitted_at: string;
  validated_at: string | null;
}

export interface ResetResponse {
  agent_id: string;
  capability_rank: 0;
  rank_before: number;
  challenge_locked: string;
  drop_amount: string;
}

export interface Query {
  id: string;
  status: string;
  specialization: string;
  query_tier: "capable" | "challenger";
  stake_amount?: string;
  min_intelligence_rank?: string;
  answer_count?: number;
  has_answered?: boolean;
  has_joined?: boolean;
  decrypted_content?: string;
  created_at: string;
  answer_deadline_at?: string;
  decision_deadline_at?: string;
  answering_grace_ends_at?: string;
  extra_completion_duration_answers_seconds?: number;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}
