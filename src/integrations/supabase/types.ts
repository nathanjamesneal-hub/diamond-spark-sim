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
      automation_log: {
        Row: {
          created_at: string
          decision: string | null
          details: Json
          duration_ms: number | null
          error: string | null
          finished_at: string | null
          game_pk: number | null
          id: string
          job: string
          slate_date: string | null
          started_at: string
          status: string
        }
        Insert: {
          created_at?: string
          decision?: string | null
          details?: Json
          duration_ms?: number | null
          error?: string | null
          finished_at?: string | null
          game_pk?: number | null
          id?: string
          job: string
          slate_date?: string | null
          started_at?: string
          status: string
        }
        Update: {
          created_at?: string
          decision?: string | null
          details?: Json
          duration_ms?: number | null
          error?: string | null
          finished_at?: string | null
          game_pk?: number | null
          id?: string
          job?: string
          slate_date?: string | null
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      bets: {
        Row: {
          book: string | null
          closing_odds: number | null
          created_at: string
          game_label: string | null
          game_pk: number | null
          id: string
          line: number | null
          market: string
          notes: string | null
          odds: number
          payout: number | null
          placed_at: string
          selection: string
          settled_at: string | null
          stake: number
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          book?: string | null
          closing_odds?: number | null
          created_at?: string
          game_label?: string | null
          game_pk?: number | null
          id?: string
          line?: number | null
          market: string
          notes?: string | null
          odds: number
          payout?: number | null
          placed_at?: string
          selection: string
          settled_at?: string | null
          stake: number
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          book?: string | null
          closing_odds?: number | null
          created_at?: string
          game_label?: string | null
          game_pk?: number | null
          id?: string
          line?: number | null
          market?: string
          notes?: string | null
          odds?: number
          payout?: number | null
          placed_at?: string
          selection?: string
          settled_at?: string | null
          stake?: number
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      calibration_summary: {
        Row: {
          brier_score: number | null
          computed_at: string
          confidence_bucket: string
          id: string
          log_loss: number | null
          model_version: string
          observed_mean: number | null
          predicted_mean: number | null
          sample_size: number
          stat: string
        }
        Insert: {
          brier_score?: number | null
          computed_at?: string
          confidence_bucket: string
          id?: string
          log_loss?: number | null
          model_version: string
          observed_mean?: number | null
          predicted_mean?: number | null
          sample_size?: number
          stat: string
        }
        Update: {
          brier_score?: number | null
          computed_at?: string
          confidence_bucket?: string
          id?: string
          log_loss?: number | null
          model_version?: string
          observed_mean?: number | null
          predicted_mean?: number | null
          sample_size?: number
          stat?: string
        }
        Relationships: [
          {
            foreignKeyName: "calibration_summary_model_version_fkey"
            columns: ["model_version"]
            isOneToOne: false
            referencedRelation: "model_versions"
            referencedColumns: ["version"]
          },
        ]
      }
      cron_runs: {
        Row: {
          affected_game_ids: string[]
          created_at: string
          date: string | null
          duration_ms: number | null
          engine_ran: boolean
          error: string | null
          finished_at: string | null
          games_changed: number
          id: string
          notes: string | null
          players_changed: number
          projections_regenerated: number
          providers: Json
          started_at: string
        }
        Insert: {
          affected_game_ids?: string[]
          created_at?: string
          date?: string | null
          duration_ms?: number | null
          engine_ran?: boolean
          error?: string | null
          finished_at?: string | null
          games_changed?: number
          id?: string
          notes?: string | null
          players_changed?: number
          projections_regenerated?: number
          providers?: Json
          started_at?: string
        }
        Update: {
          affected_game_ids?: string[]
          created_at?: string
          date?: string | null
          duration_ms?: number | null
          engine_ran?: boolean
          error?: string | null
          finished_at?: string | null
          games_changed?: number
          id?: string
          notes?: string | null
          players_changed?: number
          projections_regenerated?: number
          providers?: Json
          started_at?: string
        }
        Relationships: []
      }
      favorites: {
        Row: {
          created_at: string
          id: string
          kind: string
          label: string | null
          ref_id: number
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          label?: string | null
          ref_id: number
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          label?: string | null
          ref_id?: number
          user_id?: string
        }
        Relationships: []
      }
      forecast_consensus: {
        Row: {
          completeness: Json
          components: Json
          computed_at: string
          consensus_score: number
          consensus_version: string
          forecast_run_id: string
          id: string
          input_hash: string
          lineup_state: Json
          market: string
          missing_components: string[]
          notes: string | null
          player_id: string
          reference_meta: Json
          score_confidence: number
          uncertainty: Json
          weights: Json
        }
        Insert: {
          completeness?: Json
          components?: Json
          computed_at?: string
          consensus_score: number
          consensus_version: string
          forecast_run_id: string
          id?: string
          input_hash: string
          lineup_state?: Json
          market: string
          missing_components?: string[]
          notes?: string | null
          player_id: string
          reference_meta?: Json
          score_confidence?: number
          uncertainty?: Json
          weights?: Json
        }
        Update: {
          completeness?: Json
          components?: Json
          computed_at?: string
          consensus_score?: number
          consensus_version?: string
          forecast_run_id?: string
          id?: string
          input_hash?: string
          lineup_state?: Json
          market?: string
          missing_components?: string[]
          notes?: string | null
          player_id?: string
          reference_meta?: Json
          score_confidence?: number
          uncertainty?: Json
          weights?: Json
        }
        Relationships: [
          {
            foreignKeyName: "forecast_consensus_forecast_run_id_fkey"
            columns: ["forecast_run_id"]
            isOneToOne: false
            referencedRelation: "forecast_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "forecast_consensus_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      forecast_player_projections: {
        Row: {
          confidence: number | null
          contact_score: number | null
          created_at: string
          diamond_score: number | null
          distributions: Json | null
          environment_agreement: number | null
          forecast_run_id: string
          hit_probability: number | null
          hr_probability: number | null
          inputs: Json | null
          matchup_grade: number | null
          mlb_id: number | null
          pitcher_grade: number | null
          pitcher_win_probability: number | null
          player_id: string
          power_score: number | null
          projected_outs: number | null
          quality_start_probability: number | null
          rbi_probability: number | null
          role: string
          run_probability: number | null
          sb_probability: number | null
          speed_score: number | null
          total_base_probability: number | null
        }
        Insert: {
          confidence?: number | null
          contact_score?: number | null
          created_at?: string
          diamond_score?: number | null
          distributions?: Json | null
          environment_agreement?: number | null
          forecast_run_id: string
          hit_probability?: number | null
          hr_probability?: number | null
          inputs?: Json | null
          matchup_grade?: number | null
          mlb_id?: number | null
          pitcher_grade?: number | null
          pitcher_win_probability?: number | null
          player_id: string
          power_score?: number | null
          projected_outs?: number | null
          quality_start_probability?: number | null
          rbi_probability?: number | null
          role: string
          run_probability?: number | null
          sb_probability?: number | null
          speed_score?: number | null
          total_base_probability?: number | null
        }
        Update: {
          confidence?: number | null
          contact_score?: number | null
          created_at?: string
          diamond_score?: number | null
          distributions?: Json | null
          environment_agreement?: number | null
          forecast_run_id?: string
          hit_probability?: number | null
          hr_probability?: number | null
          inputs?: Json | null
          matchup_grade?: number | null
          mlb_id?: number | null
          pitcher_grade?: number | null
          pitcher_win_probability?: number | null
          player_id?: string
          power_score?: number | null
          projected_outs?: number | null
          quality_start_probability?: number | null
          rbi_probability?: number | null
          role?: string
          run_probability?: number | null
          sb_probability?: number | null
          speed_score?: number | null
          total_base_probability?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "forecast_player_projections_forecast_run_id_fkey"
            columns: ["forecast_run_id"]
            isOneToOne: false
            referencedRelation: "forecast_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      forecast_runs: {
        Row: {
          created_at: string
          created_by: string | null
          game_id: string
          game_pk: number
          generated_at: string
          id: string
          input_hash: string | null
          locked_at: string | null
          material_inputs: Json | null
          model_version: string
          notes: string | null
          projection_class: string
          simulation_seed: string | null
          slate_date: string
          status: string
          superseded_by: string | null
          trigger_reason: string
          updated_at: string
          version_number: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          game_id: string
          game_pk: number
          generated_at?: string
          id?: string
          input_hash?: string | null
          locked_at?: string | null
          material_inputs?: Json | null
          model_version: string
          notes?: string | null
          projection_class?: string
          simulation_seed?: string | null
          slate_date: string
          status: string
          superseded_by?: string | null
          trigger_reason: string
          updated_at?: string
          version_number: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          game_id?: string
          game_pk?: number
          generated_at?: string
          id?: string
          input_hash?: string | null
          locked_at?: string | null
          material_inputs?: Json | null
          model_version?: string
          notes?: string | null
          projection_class?: string
          simulation_seed?: string | null
          slate_date?: string
          status?: string
          superseded_by?: string | null
          trigger_reason?: string
          updated_at?: string
          version_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "forecast_runs_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "forecast_runs_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "forecast_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      game_lineup_status: {
        Row: {
          confidence: number
          created_at: string
          game_id: string
          hitters_expected: number
          hitters_set: number
          last_refresh_at: string
          notes: Json | null
          primary_source: string | null
          source_count: number
          status: string
          updated_at: string
        }
        Insert: {
          confidence?: number
          created_at?: string
          game_id: string
          hitters_expected?: number
          hitters_set?: number
          last_refresh_at?: string
          notes?: Json | null
          primary_source?: string | null
          source_count?: number
          status?: string
          updated_at?: string
        }
        Update: {
          confidence?: number
          created_at?: string
          game_id?: string
          hitters_expected?: number
          hitters_set?: number
          last_refresh_at?: string
          notes?: Json | null
          primary_source?: string | null
          source_count?: number
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "game_lineup_status_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: true
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
        ]
      }
      games: {
        Row: {
          away_team_id: string | null
          ballpark: string | null
          created_at: string
          date: string
          first_pitch_at: string | null
          game_status: string | null
          home_team_id: string | null
          id: string
          lineups_locked_at: string | null
          mlb_game_id: number
          updated_at: string
          weather: Json | null
        }
        Insert: {
          away_team_id?: string | null
          ballpark?: string | null
          created_at?: string
          date: string
          first_pitch_at?: string | null
          game_status?: string | null
          home_team_id?: string | null
          id?: string
          lineups_locked_at?: string | null
          mlb_game_id: number
          updated_at?: string
          weather?: Json | null
        }
        Update: {
          away_team_id?: string | null
          ballpark?: string | null
          created_at?: string
          date?: string
          first_pitch_at?: string | null
          game_status?: string | null
          home_team_id?: string | null
          id?: string
          lineups_locked_at?: string | null
          mlb_game_id?: number
          updated_at?: string
          weather?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "games_away_team_id_fkey"
            columns: ["away_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "games_home_team_id_fkey"
            columns: ["home_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      lineup_sources: {
        Row: {
          content_hash: string
          created_at: string
          game_id: string
          id: string
          imported_at: string
          payload: Json
          source: string
          team_id: string
          updated_at: string
        }
        Insert: {
          content_hash: string
          created_at?: string
          game_id: string
          id?: string
          imported_at?: string
          payload: Json
          source: string
          team_id: string
          updated_at?: string
        }
        Update: {
          content_hash?: string
          created_at?: string
          game_id?: string
          id?: string
          imported_at?: string
          payload?: Json
          source?: string
          team_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lineup_sources_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lineup_sources_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      lineups: {
        Row: {
          batting_order: number
          confirmed: boolean
          confirmed_at: string | null
          created_at: string
          game_id: string
          imported_at: string
          lineup_source: string
          lineup_status: string
          locked_at: string | null
          player_id: string
          team_id: string | null
          updated_at: string
        }
        Insert: {
          batting_order: number
          confirmed?: boolean
          confirmed_at?: string | null
          created_at?: string
          game_id: string
          imported_at?: string
          lineup_source?: string
          lineup_status?: string
          locked_at?: string | null
          player_id: string
          team_id?: string | null
          updated_at?: string
        }
        Update: {
          batting_order?: number
          confirmed?: boolean
          confirmed_at?: string | null
          created_at?: string
          game_id?: string
          imported_at?: string
          lineup_source?: string
          lineup_status?: string
          locked_at?: string | null
          player_id?: string
          team_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lineups_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lineups_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lineups_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      model_versions: {
        Row: {
          active: boolean
          created_at: string
          notes: string | null
          release_date: string
          version: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          notes?: string | null
          release_date?: string
          version: string
        }
        Update: {
          active?: boolean
          created_at?: string
          notes?: string | null
          release_date?: string
          version?: string
        }
        Relationships: []
      }
      petri_forecast_runs: {
        Row: {
          abstention_reasons: Json | null
          created_at: string
          data_completeness: Json
          fallbacks: Json | null
          game_date: string
          game_id: string
          id: string
          input_hash: string
          input_source_map: Json
          iterations: number
          locked_at: string | null
          mlb_game_id: number
          model_version: string
          projection_class: string
          seed: number
          status: string
          updated_at: string
        }
        Insert: {
          abstention_reasons?: Json | null
          created_at?: string
          data_completeness?: Json
          fallbacks?: Json | null
          game_date: string
          game_id: string
          id?: string
          input_hash: string
          input_source_map?: Json
          iterations: number
          locked_at?: string | null
          mlb_game_id: number
          model_version?: string
          projection_class?: string
          seed: number
          status: string
          updated_at?: string
        }
        Update: {
          abstention_reasons?: Json | null
          created_at?: string
          data_completeness?: Json
          fallbacks?: Json | null
          game_date?: string
          game_id?: string
          id?: string
          input_hash?: string
          input_source_map?: Json
          iterations?: number
          locked_at?: string | null
          mlb_game_id?: number
          model_version?: string
          projection_class?: string
          seed?: number
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "petri_forecast_runs_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
        ]
      }
      petri_player_market_snapshots: {
        Row: {
          bf_mean: number | null
          calibrated_probability: number | null
          created_at: string
          data_completeness: number | null
          game_id: string
          h_mean: number | null
          h_p10: number | null
          h_p50: number | null
          h_p90: number | null
          hit_1plus: number | null
          hitter_k_mean: number | null
          hitter_k_p10: number | null
          hitter_k_p50: number | null
          hitter_k_p90: number | null
          hr_1plus: number | null
          hr_mean: number | null
          hr_p10: number | null
          hr_p50: number | null
          hr_p90: number | null
          id: string
          is_confirmed_starter: boolean | null
          lineup_slot: number | null
          mlb_player_id: number
          outs_mean: number | null
          outs_p10: number | null
          outs_p90: number | null
          pa_mean: number | null
          pk_mean: number | null
          pk_p10: number | null
          pk_p90: number | null
          player_id: string | null
          raw_probability_label: string
          role: string
          run_id: string
          source_map: Json
          tb_2plus: number | null
          tb_mean: number | null
          tb_p10: number | null
          tb_p50: number | null
          tb_p90: number | null
          team_id: string | null
        }
        Insert: {
          bf_mean?: number | null
          calibrated_probability?: number | null
          created_at?: string
          data_completeness?: number | null
          game_id: string
          h_mean?: number | null
          h_p10?: number | null
          h_p50?: number | null
          h_p90?: number | null
          hit_1plus?: number | null
          hitter_k_mean?: number | null
          hitter_k_p10?: number | null
          hitter_k_p50?: number | null
          hitter_k_p90?: number | null
          hr_1plus?: number | null
          hr_mean?: number | null
          hr_p10?: number | null
          hr_p50?: number | null
          hr_p90?: number | null
          id?: string
          is_confirmed_starter?: boolean | null
          lineup_slot?: number | null
          mlb_player_id: number
          outs_mean?: number | null
          outs_p10?: number | null
          outs_p90?: number | null
          pa_mean?: number | null
          pk_mean?: number | null
          pk_p10?: number | null
          pk_p90?: number | null
          player_id?: string | null
          raw_probability_label?: string
          role: string
          run_id: string
          source_map?: Json
          tb_2plus?: number | null
          tb_mean?: number | null
          tb_p10?: number | null
          tb_p50?: number | null
          tb_p90?: number | null
          team_id?: string | null
        }
        Update: {
          bf_mean?: number | null
          calibrated_probability?: number | null
          created_at?: string
          data_completeness?: number | null
          game_id?: string
          h_mean?: number | null
          h_p10?: number | null
          h_p50?: number | null
          h_p90?: number | null
          hit_1plus?: number | null
          hitter_k_mean?: number | null
          hitter_k_p10?: number | null
          hitter_k_p50?: number | null
          hitter_k_p90?: number | null
          hr_1plus?: number | null
          hr_mean?: number | null
          hr_p10?: number | null
          hr_p50?: number | null
          hr_p90?: number | null
          id?: string
          is_confirmed_starter?: boolean | null
          lineup_slot?: number | null
          mlb_player_id?: number
          outs_mean?: number | null
          outs_p10?: number | null
          outs_p90?: number | null
          pa_mean?: number | null
          pk_mean?: number | null
          pk_p10?: number | null
          pk_p90?: number | null
          player_id?: string | null
          raw_probability_label?: string
          role?: string
          run_id?: string
          source_map?: Json
          tb_2plus?: number | null
          tb_mean?: number | null
          tb_p10?: number | null
          tb_p50?: number | null
          tb_p90?: number | null
          team_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "petri_player_market_snapshots_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "petri_player_market_snapshots_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "petri_player_market_snapshots_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "petri_forecast_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "petri_player_market_snapshots_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      petri_skill_profiles: {
        Row: {
          adjustments: Json
          base_rates: Json
          created_at: string
          data_completeness: number
          fallbacks: Json
          features: Json
          game_id: string
          handedness: string | null
          id: string
          is_confirmed_starter: boolean | null
          lineup_slot: number | null
          mlb_player_id: number
          opposing_hand: string | null
          pa_outcome_rates: Json
          player_id: string | null
          profile_version: string
          role: string
          run_id: string
          side: string
          team_id: string | null
        }
        Insert: {
          adjustments?: Json
          base_rates: Json
          created_at?: string
          data_completeness?: number
          fallbacks?: Json
          features: Json
          game_id: string
          handedness?: string | null
          id?: string
          is_confirmed_starter?: boolean | null
          lineup_slot?: number | null
          mlb_player_id: number
          opposing_hand?: string | null
          pa_outcome_rates: Json
          player_id?: string | null
          profile_version?: string
          role: string
          run_id: string
          side: string
          team_id?: string | null
        }
        Update: {
          adjustments?: Json
          base_rates?: Json
          created_at?: string
          data_completeness?: number
          fallbacks?: Json
          features?: Json
          game_id?: string
          handedness?: string | null
          id?: string
          is_confirmed_starter?: boolean | null
          lineup_slot?: number | null
          mlb_player_id?: number
          opposing_hand?: string | null
          pa_outcome_rates?: Json
          player_id?: string | null
          profile_version?: string
          role?: string
          run_id?: string
          side?: string
          team_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "petri_skill_profiles_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "petri_skill_profiles_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "petri_skill_profiles_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "petri_forecast_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "petri_skill_profiles_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      player_dna: {
        Row: {
          consistency: number
          contact: number
          created_at: string
          discipline: number
          last_recomputed_at: string | null
          player_id: string
          power: number
          speed: number
          updated_at: string
        }
        Insert: {
          consistency?: number
          contact?: number
          created_at?: string
          discipline?: number
          last_recomputed_at?: string | null
          player_id: string
          power?: number
          speed?: number
          updated_at?: string
        }
        Update: {
          consistency?: number
          contact?: number
          created_at?: string
          discipline?: number
          last_recomputed_at?: string | null
          player_id?: string
          power?: number
          speed?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "player_dna_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: true
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      players: {
        Row: {
          active: boolean
          bats: string | null
          created_at: string
          id: string
          mlb_id: number
          name: string
          position: string | null
          team_id: string | null
          throws: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          bats?: string | null
          created_at?: string
          id?: string
          mlb_id: number
          name: string
          position?: string | null
          team_id?: string | null
          throws?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          bats?: string | null
          created_at?: string
          id?: string
          mlb_id?: number
          name?: string
          position?: string | null
          team_id?: string | null
          throws?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "players_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          default_unit_size: number
          display_name: string | null
          favorite_team_id: number | null
          id: string
          updated_at: string
          username: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          default_unit_size?: number
          display_name?: string | null
          favorite_team_id?: number | null
          id: string
          updated_at?: string
          username?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          default_unit_size?: number
          display_name?: string | null
          favorite_team_id?: number | null
          id?: string
          updated_at?: string
          username?: string | null
        }
        Relationships: []
      }
      projection_results: {
        Row: {
          game_id: string
          hits: number
          home_runs: number
          id: string
          ingested_at: string
          plate_appearances: number
          player_id: string
          rbis: number
          runs: number
          stolen_bases: number
          strikeouts: number
          total_bases: number
          walks: number
        }
        Insert: {
          game_id: string
          hits?: number
          home_runs?: number
          id?: string
          ingested_at?: string
          plate_appearances?: number
          player_id: string
          rbis?: number
          runs?: number
          stolen_bases?: number
          strikeouts?: number
          total_bases?: number
          walks?: number
        }
        Update: {
          game_id?: string
          hits?: number
          home_runs?: number
          id?: string
          ingested_at?: string
          plate_appearances?: number
          player_id?: string
          rbis?: number
          runs?: number
          stolen_bases?: number
          strikeouts?: number
          total_bases?: number
          walks?: number
        }
        Relationships: [
          {
            foreignKeyName: "projection_results_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projection_results_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      projections: {
        Row: {
          confidence: number | null
          contact_score: number | null
          created_at: string
          diamond_score: number | null
          environment_agreement: number | null
          game_environment: Json | null
          game_id: string
          hit_probability: number | null
          hr_probability: number | null
          id: string
          inputs: Json | null
          lineup_confidence: number | null
          lineup_source: string | null
          lineup_status: string | null
          matchup_grade: number | null
          model_version: string
          pitcher_grade: number | null
          pitcher_win_probability: number | null
          player_id: string
          power_score: number | null
          projected_outs: number | null
          projection_class: string
          projection_role: string
          projection_status: string
          quality_start_probability: number | null
          rbi_probability: number | null
          run_probability: number | null
          sb_probability: number | null
          sim_snapshot: Json | null
          speed_score: number | null
          total_base_probability: number | null
        }
        Insert: {
          confidence?: number | null
          contact_score?: number | null
          created_at?: string
          diamond_score?: number | null
          environment_agreement?: number | null
          game_environment?: Json | null
          game_id: string
          hit_probability?: number | null
          hr_probability?: number | null
          id?: string
          inputs?: Json | null
          lineup_confidence?: number | null
          lineup_source?: string | null
          lineup_status?: string | null
          matchup_grade?: number | null
          model_version: string
          pitcher_grade?: number | null
          pitcher_win_probability?: number | null
          player_id: string
          power_score?: number | null
          projected_outs?: number | null
          projection_class?: string
          projection_role?: string
          projection_status?: string
          quality_start_probability?: number | null
          rbi_probability?: number | null
          run_probability?: number | null
          sb_probability?: number | null
          sim_snapshot?: Json | null
          speed_score?: number | null
          total_base_probability?: number | null
        }
        Update: {
          confidence?: number | null
          contact_score?: number | null
          created_at?: string
          diamond_score?: number | null
          environment_agreement?: number | null
          game_environment?: Json | null
          game_id?: string
          hit_probability?: number | null
          hr_probability?: number | null
          id?: string
          inputs?: Json | null
          lineup_confidence?: number | null
          lineup_source?: string | null
          lineup_status?: string | null
          matchup_grade?: number | null
          model_version?: string
          pitcher_grade?: number | null
          pitcher_win_probability?: number | null
          player_id?: string
          power_score?: number | null
          projected_outs?: number | null
          projection_class?: string
          projection_role?: string
          projection_status?: string
          quality_start_probability?: number | null
          rbi_probability?: number | null
          run_probability?: number | null
          sb_probability?: number | null
          sim_snapshot?: Json | null
          speed_score?: number | null
          total_base_probability?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "projections_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projections_model_version_fkey"
            columns: ["model_version"]
            isOneToOne: false
            referencedRelation: "model_versions"
            referencedColumns: ["version"]
          },
          {
            foreignKeyName: "projections_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      starting_pitchers: {
        Row: {
          confirmed: boolean
          created_at: string
          game_id: string
          player_id: string
          team_id: string
          updated_at: string
        }
        Insert: {
          confirmed?: boolean
          created_at?: string
          game_id: string
          player_id: string
          team_id: string
          updated_at?: string
        }
        Update: {
          confirmed?: boolean
          created_at?: string
          game_id?: string
          player_id?: string
          team_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "starting_pitchers_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "starting_pitchers_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "starting_pitchers_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      teams: {
        Row: {
          abbreviation: string
          created_at: string
          division: string | null
          id: string
          league: string | null
          mlb_team_id: number
          name: string
          updated_at: string
        }
        Insert: {
          abbreviation: string
          created_at?: string
          division?: string | null
          id?: string
          league?: string | null
          mlb_team_id: number
          name: string
          updated_at?: string
        }
        Update: {
          abbreviation?: string
          created_at?: string
          division?: string | null
          id?: string
          league?: string | null
          mlb_team_id?: number
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_app_member: { Args: never; Returns: boolean }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user"
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "moderator", "user"],
    },
  },
} as const
