-- Profiles: extends auth.users
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT UNIQUE,
  display_name TEXT,
  avatar_url TEXT,
  favorite_team_id INTEGER,
  default_unit_size NUMERIC(10,2) NOT NULL DEFAULT 10,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Profiles are viewable by anyone" ON public.profiles
  FOR SELECT USING (true);
CREATE POLICY "Users can insert their own profile" ON public.profiles
  FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "Users can update their own profile" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
    NEW.raw_user_meta_data->>'avatar_url'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- updated_at helper
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_touch_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Bets: personal wager log
CREATE TABLE public.bets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  game_pk INTEGER,
  game_label TEXT,
  market TEXT NOT NULL,
  selection TEXT NOT NULL,
  line NUMERIC(8,2),
  odds INTEGER NOT NULL,
  stake NUMERIC(10,2) NOT NULL,
  book TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost','push','void')),
  payout NUMERIC(10,2),
  closing_odds INTEGER,
  notes TEXT,
  placed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bets TO authenticated;
GRANT ALL ON public.bets TO service_role;
ALTER TABLE public.bets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own bets" ON public.bets
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert their own bets" ON public.bets
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own bets" ON public.bets
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete their own bets" ON public.bets
  FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER bets_touch_updated_at
  BEFORE UPDATE ON public.bets
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE INDEX bets_user_placed_idx ON public.bets (user_id, placed_at DESC);
CREATE INDEX bets_user_status_idx ON public.bets (user_id, status);

-- Favorites: track teams/players a user follows
CREATE TABLE public.favorites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('team','player')),
  ref_id INTEGER NOT NULL,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, ref_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.favorites TO authenticated;
GRANT ALL ON public.favorites TO service_role;
ALTER TABLE public.favorites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own favorites" ON public.favorites
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);