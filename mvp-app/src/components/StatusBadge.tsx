// StatusBadge.tsx — Único badge de status operacional da UI (STATUS-P0b).
// Antes do cutoff não renderiza nada; a partir do cutoff renderiza somente
// Pago (posted) ou Não pago (qualquer status ativo não-posted).
import React from 'react';
import { displayPaymentStatus, isPaidStatus } from '../lib/status';

interface StatusBadgeProps {
  status: string | null | undefined;
  occurredOn: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, occurredOn }) => {
  const label = displayPaymentStatus(status, occurredOn);
  if (!label) return null;
  return (
    <span className={`badge badge-${isPaidStatus(status) ? 'posted' : 'pending'}`} title={label}>
      {label}
    </span>
  );
};