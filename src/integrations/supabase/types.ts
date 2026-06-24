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
