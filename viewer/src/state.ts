// WHAT MORE THAN ONE PAGE READS: the Home state (its robot is the robot every page shows), the
// playbook's and the team-play search's status (the top pill shows a long search wherever you are),
// the staged field (diagrams draw on it), and a tiny event bus between pages.
import type { World } from '../../dsim-main/src/types';
import type { HomeV, PlaybookStatusV, PlaybookV } from './data';

export interface TeamStatusV {
  running: boolean;
  done: number;
  total: number;
  current: string | null;
  log?: string[];
  stage?: string | null;
  matches?: number;
  matchesTotal?: number;
  allMatches?: number;
  startedAt?: string | null;
  partnerAt?: string | null;
  partnerS?: number | null;
  estimated?: boolean;
  beat?: string | null;
}

export const S: {
  home: HomeV | null;
  pb: PlaybookV | null;
  pbStatus: PlaybookStatusV | null;
  tpStatus: TeamStatusV | null;
  field: World | null;
  page: string;
} = { home: null, pb: null, pbStatus: null, tpStatus: null, field: null, page: 'home' };

/** the robot the studio is about (Home's choice) */
export const profile = (): string | undefined => S.home?.profile;
export const profileQuery = (): string => (S.home?.profile ? `?profile=${encodeURIComponent(S.home.profile)}` : '');

type Fn = (data?: unknown) => void;
const subs = new Map<string, Set<Fn>>();
export const bus = {
  on(evt: string, fn: Fn): void {
    if (!subs.has(evt)) subs.set(evt, new Set());
    subs.get(evt)!.add(fn);
  },
  emit(evt: string, data?: unknown): void {
    for (const fn of subs.get(evt) ?? []) fn(data);
  },
};
