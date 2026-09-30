export const en = {
  uploadAuth: {
    title: 'Upload authentication',
    session: 'Roblox session · no API key',
    personal_key: 'Personal API key',
    group_key: 'Group API key',
    sessionPersonal:
      'Uploads to your personal account use your Roblox login. A personal API key is optional.',
    sessionGroup:
      'Uploads to this group use your Roblox login. A group API key is optional; your account still needs permission to create assets for this group.',
    personalKey:
      'Uploads use the saved personal API key. It must authorize asset creation for the selected account.',
    groupKey:
      'Uploads use the saved group API key. It must authorize asset creation for this specific group.',
    personalKeyForGroup:
      'No group key is saved, so uploads use the personal key. It must authorize this group; otherwise, choose Roblox session below or add a suitable group key.',
    timing:
      'Roblox request limits and asset processing can add delays in either mode. An API key does not guarantee faster uploads. The app reports retry waits when Roblox limits requests.',
    sessionOnly: 'Use Roblox session, even with saved keys',
    sessionOnlyHelp: 'Keep your keys saved while uploading without them.',
    invalidKey:
      'The selected key was rejected. Use Roblox session, replace the key, or clear it to continue without a key.',
  },
};

export const pt = {
  uploadAuth: {
    title: 'Autenticação do envio',
    session: 'Sessão Roblox · sem API key',
    personal_key: 'API key pessoal',
    group_key: 'API key do grupo',
    sessionPersonal:
      'O envio para sua conta pessoal usa seu login Roblox. A API key pessoal é opcional.',
    sessionGroup:
      'O envio para este grupo usa seu login Roblox. A API key do grupo é opcional; sua conta precisa ter permissão para criar assets nesse grupo.',
    personalKey:
      'O envio usa a API key pessoal salva. Ela precisa autorizar a criação de assets para a conta selecionada.',
    groupKey:
      'O envio usa a API key do grupo salva. Ela precisa autorizar a criação de assets para este grupo específico.',
    personalKeyForGroup:
      'Sem chave de grupo salva, o envio usa a chave pessoal. Ela precisa autorizar este grupo; caso contrário, escolha a sessão Roblox abaixo ou adicione uma chave adequada.',
    timing:
      'Limites de requisições e processamento dos assets pelo Roblox podem causar esperas nos dois modos. API key não garante envio mais rápido. O app informa a espera para tentar novamente quando o Roblox limita as requisições.',
    sessionOnly: 'Usar sessão Roblox, mesmo com chaves salvas',
    sessionOnlyHelp: 'Mantém suas chaves salvas e faz os envios sem usá-las.',
    invalidKey:
      'A chave selecionada foi recusada. Use a sessão Roblox, substitua a chave ou limpe o campo para continuar sem chave.',
  },
};
