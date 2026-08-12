// profileSwitch.ts — Troca segura entre perfis Pessoal/Negócio (Etapa 1.2A).
// Pessoal e Negócio são usuários diferentes do Supabase (profile_id vem do JWT).
// Em produção a troca exige novo login: signOut via API oficial do Supabase e
// retorno à tela de login com mensagem orientando o próximo usuário.
// Nenhuma senha, token ou email é armazenado ou manipulado manualmente aqui.

export type ProfileCode = 'personal' | 'business';

export function targetProfileLabel(code: ProfileCode): 'Pessoal' | 'Negócio' {
  return code === 'personal' ? 'Negócio' : 'Pessoal';
}

export function switchButtonLabel(code: ProfileCode): string {
  return `Trocar para ${targetProfileLabel(code)}`;
}

export function loginNoticeMessage(code: ProfileCode): string {
  return `Entre com o usuário do perfil ${targetProfileLabel(code)}`;
}

export interface AuthLike {
  signOut(): Promise<unknown>;
}

// Executa o logout oficial do Supabase (que limpa a sessão armazenada pela
// própria API) e, somente após sucesso, devolve o controle ao aplicativo.
// Em erro, a exceção é propagada para a UI tratar (sessão permanece para
// o usuário tentar novamente).
export async function signOutAndReturn(auth: AuthLike, onDone: () => void): Promise<void> {
  await auth.signOut();
  onDone();
}
