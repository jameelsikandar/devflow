import { db } from './db';
import { decrypt } from './crypto';
import { env } from './env';
import { githubRequest } from './github-request';
// Compatibility wrapper for existing OAuth/repository UI consumers.
export async function githubFetch(path: string, accessToken: string) {
  return await githubRequest(path, accessToken);
}
export async function githubData(userId: string, repository: string | null) {
  const config = env();
  const configured = !!(
    config.GITHUB_CLIENT_ID &&
    config.GITHUB_CLIENT_SECRET &&
    config.TOKEN_ENCRYPTION_KEY
  );
  const connection = await db.gitHubConnection.findUnique({ where: { userId } });
  if (!connection) {
    return {
      configured,
      connected: false,
      demo: config.GITHUB_DEMO === 'true',
      repositories:
        config.GITHUB_DEMO === 'true'
          ? [
              {
                id: 1,
                full_name: 'sample/devflow',
                description: 'Sample repository — configure GitHub OAuth for live activity.',
                html_url: 'https://github.com',
                language: 'TypeScript',
                stargazers_count: 0,
                private: false,
              },
            ]
          : [],
    };
  }
  const accessToken = decrypt(connection.encryptedToken);
  const repositories = await githubFetch('/user/repos?sort=updated&per_page=100', accessToken);
  const [commits, pulls] = repository
    ? await Promise.all([
        githubFetch(`/repos/${repository}/commits?per_page=8`, accessToken),
        githubFetch(`/repos/${repository}/pulls?state=open&per_page=8`, accessToken),
      ])
    : [[], []];
  return { configured, connected: true, login: connection.login, repositories, commits, pulls };
}
