export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      api_rate_limit_windows: {
        Row: {
          expires_at: string
          operation: string
          request_count: number
          user_id: string
          window_started_at: string
        }
        Insert: {
          expires_at: string
          operation: string
          request_count: number
          user_id: string
          window_started_at: string
        }
        Update: {
          expires_at?: string
          operation?: string
          request_count?: number
          user_id?: string
          window_started_at?: string
        }
        Relationships: []
      }
      audit_events: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          id: string
          organization_id: string
          outcome: string
          target_id: string | null
          target_type: string
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          id?: string
          organization_id: string
          outcome: string
          target_id?: string | null
          target_type: string
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          id?: string
          organization_id?: string
          outcome?: string
          target_id?: string | null
          target_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_organization_id_actor_user_id_fkey"
            columns: ["organization_id", "actor_user_id"]
            isOneToOne: false
            referencedRelation: "memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
          {
            foreignKeyName: "audit_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      call_intents: {
        Row: {
          consumed_call_sid: string | null
          created_at: string
          destination: string
          device_id: string
          expires_at: string
          id: string
          line_id: string
          organization_id: string
          reservation_id: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          consumed_call_sid?: string | null
          created_at?: string
          destination: string
          device_id: string
          expires_at: string
          id?: string
          line_id: string
          organization_id: string
          reservation_id?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          consumed_call_sid?: string | null
          created_at?: string
          destination?: string
          device_id?: string
          expires_at?: string
          id?: string
          line_id?: string
          organization_id?: string
          reservation_id?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_intents_organization_id_device_id_user_id_fkey"
            columns: ["organization_id", "device_id", "user_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["organization_id", "id", "user_id"]
          },
          {
            foreignKeyName: "call_intents_organization_id_line_id_fkey"
            columns: ["organization_id", "line_id"]
            isOneToOne: false
            referencedRelation: "lines"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "call_intents_reservation_id_fkey"
            columns: ["reservation_id"]
            isOneToOne: false
            referencedRelation: "call_reservations"
            referencedColumns: ["id"]
          },
        ]
      }
      call_legs: {
        Row: {
          answered_at: string | null
          call_id: string
          created_at: string
          device_id: string | null
          duration_seconds: number | null
          ended_at: string | null
          id: string
          last_reconciled_at: string | null
          organization_id: string
          parent_call_sid: string | null
          provider_call_sid: string
          reconcile_after: string
          reconcile_attempts: number
          started_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          answered_at?: string | null
          call_id: string
          created_at?: string
          device_id?: string | null
          duration_seconds?: number | null
          ended_at?: string | null
          id?: string
          last_reconciled_at?: string | null
          organization_id: string
          parent_call_sid?: string | null
          provider_call_sid: string
          reconcile_after?: string
          reconcile_attempts?: number
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          answered_at?: string | null
          call_id?: string
          created_at?: string
          device_id?: string | null
          duration_seconds?: number | null
          ended_at?: string | null
          id?: string
          last_reconciled_at?: string | null
          organization_id?: string
          parent_call_sid?: string | null
          provider_call_sid?: string
          reconcile_after?: string
          reconcile_attempts?: number
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_legs_organization_id_call_id_fkey"
            columns: ["organization_id", "call_id"]
            isOneToOne: false
            referencedRelation: "calls"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "call_legs_organization_id_device_id_fkey"
            columns: ["organization_id", "device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      call_reservations: {
        Row: {
          call_id: string | null
          created_at: string
          expires_at: string
          id: string
          organization_id: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          call_id?: string | null
          created_at?: string
          expires_at: string
          id?: string
          organization_id: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          call_id?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          organization_id?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_reservations_organization_id_call_id_fkey"
            columns: ["organization_id", "call_id"]
            isOneToOne: false
            referencedRelation: "calls"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "call_reservations_organization_id_user_id_fkey"
            columns: ["organization_id", "user_id"]
            isOneToOne: false
            referencedRelation: "memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
        ]
      }
      calls: {
        Row: {
          answered_at: string | null
          created_at: string
          direction: string
          duration_seconds: number | null
          ended_at: string | null
          id: string
          line_id: string
          organization_id: string
          remote_number: string
          result_code: string | null
          started_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          answered_at?: string | null
          created_at?: string
          direction: string
          duration_seconds?: number | null
          ended_at?: string | null
          id?: string
          line_id: string
          organization_id: string
          remote_number: string
          result_code?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          answered_at?: string | null
          created_at?: string
          direction?: string
          duration_seconds?: number | null
          ended_at?: string | null
          id?: string
          line_id?: string
          organization_id?: string
          remote_number?: string
          result_code?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "calls_organization_id_line_id_fkey"
            columns: ["organization_id", "line_id"]
            isOneToOne: false
            referencedRelation: "lines"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      contact_phones: {
        Row: {
          contact_id: string
          created_at: string
          id: string
          label: string
          organization_id: string
          phone_number: string
        }
        Insert: {
          contact_id: string
          created_at?: string
          id?: string
          label?: string
          organization_id: string
          phone_number: string
        }
        Update: {
          contact_id?: string
          created_at?: string
          id?: string
          label?: string
          organization_id?: string
          phone_number?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_phones_organization_id_contact_id_fkey"
            columns: ["organization_id", "contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      contacts: {
        Row: {
          archived_at: string | null
          created_at: string
          display_name: string
          email: string | null
          id: string
          organization_id: string
          updated_at: string
          version: number
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          display_name: string
          email?: string | null
          id?: string
          organization_id: string
          updated_at?: string
          version?: number
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          display_name?: string
          email?: string | null
          id?: string
          organization_id?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "contacts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_reads: {
        Row: {
          conversation_id: string
          last_read_message_id: string | null
          organization_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          conversation_id: string
          last_read_message_id?: string | null
          organization_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          conversation_id?: string
          last_read_message_id?: string | null
          organization_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_reads_organization_id_conversation_id_fkey"
            columns: ["organization_id", "conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "conversation_reads_organization_id_conversation_id_last_re_fkey"
            columns: [
              "organization_id",
              "conversation_id",
              "last_read_message_id",
            ]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["organization_id", "conversation_id", "id"]
          },
          {
            foreignKeyName: "conversation_reads_organization_id_user_id_fkey"
            columns: ["organization_id", "user_id"]
            isOneToOne: false
            referencedRelation: "memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
        ]
      }
      conversations: {
        Row: {
          created_at: string
          id: string
          last_message_at: string | null
          line_id: string
          organization_id: string
          remote_number: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_message_at?: string | null
          line_id: string
          organization_id: string
          remote_number: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          last_message_at?: string | null
          line_id?: string
          organization_id?: string
          remote_number?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_organization_id_line_id_fkey"
            columns: ["organization_id", "line_id"]
            isOneToOne: false
            referencedRelation: "lines"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      devices: {
        Row: {
          created_at: string
          id: string
          label: string
          last_active_at: string | null
          organization_id: string
          platform: string
          revoked_at: string | null
          status: string
          updated_at: string
          user_id: string
          voice_identity: string
          voice_registered_at: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          label: string
          last_active_at?: string | null
          organization_id: string
          platform: string
          revoked_at?: string | null
          status?: string
          updated_at?: string
          user_id: string
          voice_identity: string
          voice_registered_at?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          label?: string
          last_active_at?: string | null
          organization_id?: string
          platform?: string
          revoked_at?: string | null
          status?: string
          updated_at?: string
          user_id?: string
          voice_identity?: string
          voice_registered_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "devices_organization_id_user_id_fkey"
            columns: ["organization_id", "user_id"]
            isOneToOne: false
            referencedRelation: "memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
        ]
      }
      idempotency_requests: {
        Row: {
          actor_user_id: string
          created_at: string
          expires_at: string
          id: string
          idempotency_key: string
          operation: string
          organization_id: string
          request_hash: string
          response_body: Json | null
          response_status: number | null
          status: string
        }
        Insert: {
          actor_user_id: string
          created_at?: string
          expires_at: string
          id?: string
          idempotency_key: string
          operation: string
          organization_id: string
          request_hash: string
          response_body?: Json | null
          response_status?: number | null
          status?: string
        }
        Update: {
          actor_user_id?: string
          created_at?: string
          expires_at?: string
          id?: string
          idempotency_key?: string
          operation?: string
          organization_id?: string
          request_hash?: string
          response_body?: Json | null
          response_status?: number | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "idempotency_requests_organization_id_actor_user_id_fkey"
            columns: ["organization_id", "actor_user_id"]
            isOneToOne: false
            referencedRelation: "memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
        ]
      }
      line_assignments: {
        Row: {
          can_sms: boolean
          can_voice: boolean
          created_at: string
          id: string
          line_id: string
          organization_id: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          can_sms?: boolean
          can_voice?: boolean
          created_at?: string
          id?: string
          line_id: string
          organization_id: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          can_sms?: boolean
          can_voice?: boolean
          created_at?: string
          id?: string
          line_id?: string
          organization_id?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "line_assignments_organization_id_line_id_fkey"
            columns: ["organization_id", "line_id"]
            isOneToOne: false
            referencedRelation: "lines"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "line_assignments_organization_id_user_id_fkey"
            columns: ["organization_id", "user_id"]
            isOneToOne: false
            referencedRelation: "memberships"
            referencedColumns: ["organization_id", "user_id"]
          },
        ]
      }
      lines: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          phone_number: string
          sms_enabled: boolean
          status: string
          twilio_account_sid: string | null
          twilio_phone_number_sid: string | null
          updated_at: string
          voice_enabled: boolean
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          phone_number: string
          sms_enabled?: boolean
          status?: string
          twilio_account_sid?: string | null
          twilio_phone_number_sid?: string | null
          updated_at?: string
          voice_enabled?: boolean
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          phone_number?: string
          sms_enabled?: boolean
          status?: string
          twilio_account_sid?: string | null
          twilio_phone_number_sid?: string | null
          updated_at?: string
          voice_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "lines_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      memberships: {
        Row: {
          created_at: string
          organization_id: string
          role: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          organization_id: string
          role?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          organization_id?: string
          role?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memberships_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          body: string
          conversation_id: string
          created_at: string
          delivered_at: string | null
          direction: string
          id: string
          organization_id: string
          provider_error_code: string | null
          provider_message_sid: string | null
          sent_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          body: string
          conversation_id: string
          created_at?: string
          delivered_at?: string | null
          direction: string
          id?: string
          organization_id: string
          provider_error_code?: string | null
          provider_message_sid?: string | null
          sent_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          body?: string
          conversation_id?: string
          created_at?: string
          delivered_at?: string | null
          direction?: string
          id?: string
          organization_id?: string
          provider_error_code?: string | null
          provider_message_sid?: string | null
          sent_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_organization_id_conversation_id_fkey"
            columns: ["organization_id", "conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      message_reconciliation_tasks: {
        Row: {
          attempts: number
          last_attempt_at: string | null
          manual_review_required: boolean
          message_id: string
          next_attempt_at: string
          organization_id: string
        }
        Insert: {
          attempts?: number
          last_attempt_at?: string | null
          manual_review_required?: boolean
          message_id: string
          next_attempt_at: string
          organization_id: string
        }
        Update: {
          attempts?: number
          last_attempt_at?: string | null
          manual_review_required?: boolean
          message_id?: string
          next_attempt_at?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_reconciliation_tasks_organization_id_message_id_fkey"
            columns: ["organization_id", "message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          id: string
          name: string
          settings: Json
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          settings?: Json
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          settings?: Json
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      provider_events: {
        Row: {
          applied_at: string | null
          dedupe_key: string
          event_type: string
          id: string
          outcome: string | null
          provider_event_at: string | null
          provider: string
          provider_account_sid: string
          provider_sequence_number: number | null
          received_at: string
          resource_sid: string | null
        }
        Insert: {
          applied_at?: string | null
          dedupe_key: string
          event_type: string
          id?: string
          outcome?: string | null
          provider_event_at?: string | null
          provider: string
          provider_account_sid: string
          provider_sequence_number?: number | null
          received_at?: string
          resource_sid?: string | null
        }
        Update: {
          applied_at?: string | null
          dedupe_key?: string
          event_type?: string
          id?: string
          outcome?: string | null
          provider_event_at?: string | null
          provider?: string
          provider_account_sid?: string
          provider_sequence_number?: number | null
          received_at?: string
          resource_sid?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      apply_call_status: {
        Args: {
          p_account_sid: string
          p_call_duration: number | null
          p_call_sid: string
          p_call_status: string
          p_parent_call_sid: string
          p_provider_event_at: string | null
          p_provider_sequence_number: number | null
        }
        Returns: Json
      }
      record_answered_call_device: {
        Args: {
          p_account_sid: string
          p_call_sid: string
          p_voice_identity: string
        }
        Returns: Json
      }
      cancel_call_intent: {
        Args: {
          p_intent_id: string
          p_user_id: string
        }
        Returns: Json
      }
      apply_message_status: {
        Args: {
          p_account_sid: string
          p_error_code?: string
          p_message_id: string
          p_message_sid: string
          p_status: string
        }
        Returns: Json
      }
      begin_inbound_call: {
        Args: {
          p_account_sid: string
          p_call_sid: string
          p_from: string
          p_max_ringing_devices?: number
          p_to: string
        }
        Returns: Json
      }
      consume_api_rate_limit: {
        Args: {
          p_max_requests: number
          p_operation: string
          p_user_id: string
          p_window_seconds: number
        }
        Returns: boolean
      }
      consume_call_intent: {
        Args: {
          p_account_sid: string
          p_call_sid: string
          p_intent_id: string
          p_voice_identity: string
        }
        Returns: Json
      }
      conversation_unread_status: {
        Args: { p_conversation_ids: string[]; p_line_id: string }
        Returns: { conversation_id: string; unread: boolean }[]
      }
      create_contact_with_phones: {
        Args: {
          p_display_name: string
          p_email: string
          p_org_id: string
          p_phones: Json
        }
        Returns: string
      }
      create_inbound_message: {
        Args: {
          p_account_sid: string
          p_body: string
          p_from: string
          p_message_sid: string
          p_to: string
        }
        Returns: Json
      }
      expire_stale_call_work: { Args: never; Returns: Json }
      issue_call_intent: {
        Args: {
          p_destination: string
          p_device_id: string
          p_idempotency_key: string
          p_line_id: string
          p_max_active_seconds?: number
          p_org_id: string
          p_request_hash: string
        }
        Returns: string
      }
      latest_conversation_messages: {
        Args: { p_conversation_ids: string[]; p_line_id: string }
        Returns: {
          body: string
          conversation_id: string
          created_at: string
          direction: string
          id: string
          status: string
        }[]
      }
      list_pending_outbound_messages: {
        Args: never
        Returns: {
          body: string
          conversation_id: string
          created_at: string
          destination: string
          idempotency_key: string
          line_id: string
          message_id: string
          organization_id: string
          status: string
        }[]
      }
      prepare_outbound_message: {
        Args: {
          p_body: string
          p_destination: string
          p_idempotency_key: string
          p_line_id: string
          p_org_id: string
          p_request_hash: string
        }
        Returns: Json
      }
      record_call_leg_reconciliation: {
        Args: {
          p_call_leg_id: string
          p_failed: boolean
          p_next_attempt_at: string
        }
        Returns: undefined
      }
      record_message_reconciliation: {
        Args: {
          p_manual_review_required?: boolean
          p_message_id: string
          p_next_attempt_at: string
        }
        Returns: boolean
      }
      set_device_voice_state: {
        Args: { p_device_id: string; p_registered: boolean }
        Returns: boolean
      }
      update_contact_with_phones: {
        Args: {
          p_contact_id: string
          p_display_name: string
          p_email: string
          p_expected_version: number
          p_org_id: string
          p_phones: Json
        }
        Returns: string
      }
      update_outbound_message_result: {
        Args: {
          p_error_code?: string
          p_message_id: string
          p_message_sid: string
          p_status: string
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
