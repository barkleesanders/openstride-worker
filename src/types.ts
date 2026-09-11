export type Goal = 'base' | '5k' | '10k' | 'half' | 'marathon';
export type Intensity = 'gentle' | 'balanced' | 'challenging';
export type PlanConfig = {
  name: string;
  goal: Goal;
  startDate: string;
  weeks: number;
  currentWeeklyKm: number;
  currentLongestKm: number;
  days: number[]; // ISO weekday: Monday=1, Sunday=7
  longRunDay: number;
  intensity: Intensity;
  recent5kMinutes?: number;
};
export type Workout = {
  id: string;
  planId: string;
  date: string;
  week: number;
  type: 'easy' | 'long' | 'tempo' | 'intervals' | 'race' | 'run-walk';
  title: string;
  distanceKm: number;
  description: string;
  paceMinSeconds?: number;
  paceMaxSeconds?: number;
  status: 'planned' | 'completed' | 'skipped';
  actualKm?: number;
  actualMinutes?: number;
  effort?: number;
  notes?: string;
};
export type Plan = {
  id: string;
  createdAt: string;
  config: PlanConfig;
  engineVersion: string;
  warnings: string[];
  workouts: Workout[];
};
export type Activity = {
  id: string;
  source: 'manual' | 'strava';
  date: string;
  name: string;
  distanceKm: number;
  durationMinutes: number;
};
export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_TOKEN: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  OWNER_EMAIL?: string;
  STRAVA_CLIENT_ID?: string;
  STRAVA_CLIENT_SECRET?: string;
  STRAVA_REDIRECT_URI?: string;
};
