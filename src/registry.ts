import type { WidgetModule } from './types.ts';
import { alerts } from './widgets/alerts.ts';
import { prs } from './widgets/prs.ts';
import { ci } from './widgets/ci.ts';
import { drift } from './widgets/drift.ts';
import { gitStatus } from './widgets/gitStatus.ts';
import { feed } from './widgets/feed.ts';
import { deadlines } from './widgets/deadlines.ts';
import { playConsole } from './widgets/playConsole.ts';
import { crashlytics } from './widgets/crashlytics.ts';
import { linear } from './widgets/linear.ts';

export const REGISTRY: WidgetModule[] = [crashlytics, ci, playConsole, prs, linear, alerts, gitStatus, deadlines, drift, feed];
