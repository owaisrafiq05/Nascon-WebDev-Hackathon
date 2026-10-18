import { Card, PageContainer, PageTitle } from '../../components/ui.js';
import { RecoveryQueue } from './RecoveryQueue.js';

/** Standalone recovery queue: the drill-down target for the dashboard tile. */
export function RecoveryPage() {
  return (
    <PageContainer>
      <PageTitle sub="Leads that were escalated repeatedly, have no owner, or went quiet.">
        Recovery queue
      </PageTitle>
      <Card id="recovery">
        <RecoveryQueue />
      </Card>
    </PageContainer>
  );
}
