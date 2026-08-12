import React, { useState } from 'react';
import { TransactionList } from '../components/TransactionList';
import { PeriodSelector } from '../components/PeriodSelector';
import type { PeriodController } from '../components/AppShell';

interface TransactionsViewProps {
  profileId: string;
  period: PeriodController;
}

export const TransactionsView: React.FC<TransactionsViewProps> = ({ profileId, period }) => {
  const [search, setSearch] = useState('');
  const [selectedAccount, setSelectedAccount] = useState('');
  const [filterNoCategory, setFilterNoCategory] = useState(false);
  const [filterReviewOnly, setFilterReviewOnly] = useState(false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div>
        <h1 style={{ fontSize: '22px', fontWeight: 800, letterSpacing: '-0.01em', marginBottom: '4px' }}>
          Transações
        </h1>
        <p style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>
          Todas as transações do perfil ativo no período selecionado
        </p>
      </div>

      <PeriodSelector
        selection={period.selection}
        mode={period.mode}
        range={period.range}
        onSelectionChange={period.onSelectionChange}
        onModeChange={period.onModeChange}
      />

      <TransactionList
        profileId={profileId}
        selectedTransactionId={null}
        onSelectTransaction={() => {}}
        refreshTrigger={0}
        search={search}
        onSearchChange={setSearch}
        selectedAccount={selectedAccount}
        onAccountChange={setSelectedAccount}
        startDate={period.range.start}
        onStartDateChange={() => {}}
        endDate={period.range.end}
        onEndDateChange={() => {}}
        filterNoCategory={filterNoCategory}
        onFilterNoCategoryChange={setFilterNoCategory}
        filterReviewOnly={filterReviewOnly}
        onFilterReviewOnlyChange={setFilterReviewOnly}
      />
    </div>
  );
};
