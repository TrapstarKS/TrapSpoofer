/** Messages raised by src/services (also returned to MCP clients). */
export const en = {
  services: {
    scanBusy: 'A scan is already running.',
    studioScanDone: 'Studio scan complete: {count} asset(s).',
    profileNotFound: 'Profile {id} not found.',
    jobBusy: 'A spoof job is already running.',
    noProfile: 'No active Roblox profile. Add or select a profile in Accounts.',
    badCookie: "The active profile's cookie expired or is invalid. Update the profile in Accounts.",
    noAssets: 'No assets selected. Scan Studio, open a file or paste IDs.',
    quota:
      'You selected {count} audio file(s), but the monthly quota only allows {remaining} more.',
    apiKeyRejected:
      'Roblox rejected the selected API key. Choose Roblox session in upload authentication, replace the key, or clear it to continue without a key.',
    apiKeyOwnerMismatch:
      'The API key belongs to user {owner}, but the active profile is {profile}.',
    apiKeyPrecheckFailed: 'Could not pre-validate the API key ({error}).',
    launchFailed: 'Could not start the spoof: {error}',
    cancelRequested: 'Cancel requested. Assets in progress will finish first.',
    noFileLoaded: 'No .rbxl/.rbxm file loaded.',
    noMappings: 'No mappings: run the spoof before saving the file.',
    fileSaved: 'File saved: {path} ({count} replacement(s)).',
    filePartial: 'File saved: {path} ({count} applied, {failed} failed). Check the warnings.',
    needCookieProfile: 'Select a profile with a valid cookie.',
    nothingToDiscover: 'No assets to discover.',
    fileModeHint:
      'File mode: use "Save spoofed file" to apply replacements and the animation mode.',
  },
};

export const pt = {
  services: {
    scanBusy: 'Um scan já está em andamento.',
    studioScanDone: 'Scan do Studio concluído: {count} asset(s).',
    profileNotFound: 'Perfil {id} não encontrado.',
    jobBusy: 'Já existe um job de spoof rodando.',
    noProfile: 'Nenhum perfil Roblox ativo. Adicione ou selecione um perfil em Contas.',
    badCookie: 'O cookie do perfil ativo expirou ou é inválido. Atualize o perfil em Contas.',
    noAssets: 'Nenhum asset selecionado. Faça um scan, abra um arquivo ou cole IDs.',
    quota: 'Você selecionou {count} áudio(s), mas a cota mensal só permite mais {remaining}.',
    apiKeyRejected:
      'O Roblox recusou a API key selecionada. Escolha a sessão Roblox na autenticação do envio, substitua a chave ou limpe o campo para continuar sem chave.',
    apiKeyOwnerMismatch: 'A API Key pertence ao usuário {owner}, mas o perfil ativo é {profile}.',
    apiKeyPrecheckFailed: 'Não foi possível pré-validar a API Key ({error}).',
    launchFailed: 'Não foi possível iniciar o spoof: {error}',
    cancelRequested: 'Cancelamento solicitado. Os assets em andamento vão terminar primeiro.',
    noFileLoaded: 'Nenhum arquivo .rbxl/.rbxm carregado.',
    noMappings: 'Nenhum mapeamento: rode o spoof antes de salvar o arquivo.',
    fileSaved: 'Arquivo salvo: {path} ({count} substituições).',
    filePartial: 'Arquivo salvo: {path} ({count} aplicadas, {failed} falharam). Confira os avisos.',
    needCookieProfile: 'Selecione um perfil com cookie válido.',
    nothingToDiscover: 'Nenhum asset para descobrir.',
    fileModeHint:
      'Modo arquivo: use "Salvar arquivo spoofado" para aplicar as substituições e o modo de animação.',
  },
};
