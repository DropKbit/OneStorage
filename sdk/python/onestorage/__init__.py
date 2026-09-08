"""OneStorage async SDK. Streaming uploads use bounded chunks over HTTP."""
from __future__ import annotations
import asyncio, base64, hashlib, hmac, http.client, io, json, time, uuid
from urllib.parse import urlsplit, urlencode, quote
from dataclasses import dataclass
from typing import Any, BinaryIO, Iterable

class OneStorageError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        super().__init__(message)

def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b'=').decode()

def create_token(*, issuer: str, key: str | bytes, scopes: list[str], repo: str | None = None,
                 subject='onestorage-python', algorithm='ES256', ttl=3600, key_id=None, refs=None) -> str:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec, padding, utils
    if algorithm not in ('ES256', 'ES384', 'ES512', 'RS256') or not 1 <= ttl <= 365*86400:
        raise ValueError('Invalid algorithm or TTL')
    header = {'alg': algorithm, 'typ': 'JWT'}
    if key_id: header['kid'] = key_id
    now = int(time.time())
    claims = dict(iss=issuer, sub=subject, iat=now, exp=now+ttl, scopes=scopes)
    if repo: claims['repo'] = repo
    if refs is not None: claims['refs'] = refs
    value = _b64(json.dumps(header, separators=(',', ':')).encode())+'.'+_b64(json.dumps(claims, separators=(',', ':')).encode())
    private = serialization.load_pem_private_key(key.encode() if isinstance(key, str) else key, password=None)
    digest = {'ES256': hashes.SHA256, 'RS256': hashes.SHA256, 'ES384': hashes.SHA384, 'ES512': hashes.SHA512}[algorithm]()
    if algorithm == 'RS256': signature = private.sign(value.encode(), padding.PKCS1v15(), digest)
    else:
        expected = {'ES256': 256, 'ES384': 384, 'ES512': 521}[algorithm]
        if not isinstance(private, ec.EllipticCurvePrivateKey) or private.key_size != expected: raise ValueError('JWT curve mismatch')
        r, s = utils.decode_dss_signature(private.sign(value.encode(), ec.ECDSA(digest)))
        width = (expected+7)//8
        signature = r.to_bytes(width, 'big')+s.to_bytes(width, 'big')
    return value+'.'+_b64(signature)

def validate_webhook(payload: bytes | str, headers: dict, secret: str, tolerance=300):
    headers = {k.lower(): v for k, v in headers.items()}
    timestamp = headers.get('x-onestorage-timestamp', '')
    if not timestamp.isdigit() or abs(time.time()-int(timestamp)) > tolerance: return None
    body = payload.encode() if isinstance(payload, str) else payload
    expected = 'sha256='+hmac.new(secret.encode(), timestamp.encode()+b'.'+body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, headers.get('x-onestorage-signature', '')): return None
    return json.loads(body)

@dataclass
class Response:
    status: int
    headers: dict[str, str]
    body: bytes
    def json(self): return json.loads(self.body)

class OneStorage:
    def __init__(self, origin: str, token: str | None = None, *, signer: dict | None = None, timeout=60):
        self.origin = origin.rstrip('/')
        parsed = urlsplit(self.origin)
        if parsed.scheme not in ('http','https') or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
            raise ValueError('Origin must be an HTTP(S) origin without credentials or path')
        self.token, self.signer, self.timeout = token, signer, timeout

    def _raw(self, path, method='GET', body=None, headers=None, repo=None, scopes=None, sink: BinaryIO | None=None):
        parsed = urlsplit(self.origin)
        connection = (http.client.HTTPSConnection if parsed.scheme == 'https' else http.client.HTTPConnection)(parsed.hostname, parsed.port, timeout=self.timeout)
        headers = dict(headers or {})
        token = self.token or (create_token(**self.signer, repo=repo, scopes=scopes) if self.signer else None)
        if token: headers['Authorization'] = 'Bearer '+token
        try:
            connection.request(method, '/api'+path, body=body, headers=headers, encode_chunked=body is not None and not isinstance(body, (str, bytes)))
            response = connection.getresponse()
            if not 200 <= response.status < 300 and response.status != 304:
                raw = response.read(1024*1024)
                try: message = json.loads(raw).get('error', response.reason)
                except (ValueError, AttributeError): message = response.reason
                raise OneStorageError(response.status, message)
            if sink is not None:
                while chunk := response.read(1024*1024): sink.write(chunk)
                data = b''
            else:
                data = response.read(64*1024*1024+1)
                if len(data) > 64*1024*1024: raise ValueError('Response too large; use a download sink')
            return Response(response.status, {k.lower(): v for k,v in response.getheaders()}, data)
        finally: connection.close()

    async def raw(self, path, method='GET', body=None, **options):
        return await asyncio.to_thread(self._raw, path, method, body, **options)

    async def request(self, path, method='GET', body=None, **options):
        response = await self.raw(path, method, None if body is None else json.dumps(body).encode(), headers={'Content-Type':'application/json'}, **options)
        return response.json()

    async def create_repo(self, **options):
        name = options.get('name') or options.get('id') or str(uuid.uuid4())
        repo = (self.signer['issuer']+'/' if self.signer else '')+name
        return await self.request('/repos','POST',{**options,'name':name},repo=repo,scopes=['repo:write','git:read'] if options.get('base_repo',{}).get('id') else ['repo:write'])

    async def list_repos(self, **options):
        return await self.request('/repos?'+urlencode(options),scopes=['org:read'])

    async def repositories(self, **options):
        while True:
            page = await self.list_repos(**options)
            for repo in page['repositories']: yield repo
            if not page.get('next_cursor'): break
            options['cursor'] = page['next_cursor']

    async def resolve_repo(self, id: str, repository: str | None = None):
        if self.signer and not repository:
            async for item in self.repositories():
                if item['id'] == id:
                    repository = item['namespace']+'/'+item['name']
                    break
            if not repository: raise OneStorageError(404, 'Repository not found')
        return await self.request('/repo-url/'+quote(id,safe=''), repo=repository or id, scopes=['git:read'])

    def repo(self, namespace: str, name: str): return Repository(self, namespace, name)

class Repository:
    def __init__(self, client: OneStorage, namespace: str, name: str):
        self.client, self.id = client, namespace+'/'+name
        self.path = '/repos/'+quote(namespace,safe='')+'/'+quote(name,safe='')

    async def _request(self, endpoint='', method='GET', options=None, scope=None):
        scope = scope or ('git:read' if method == 'GET' or endpoint in ('grep','archive') else 'git:write')
        path = self.path+('/'+endpoint if endpoint else '')
        if method == 'GET' and options: path += '?'+urlencode({k:v for k,v in options.items() if v is not None},doseq=True).replace('=True','=true').replace('=False','=false')
        return await self.client.request(path,method,None if method=='GET' else options,repo=self.id,scopes=[scope])

    async def get_file(self, path, *, ref='HEAD', ephemeral=False, headers=None, head=False, sink=None):
        return await self.client.raw(self.path+'/file?'+urlencode({'path':path,'ref':ref,'ephemeral':str(ephemeral).lower()}),'HEAD' if head else 'GET',headers=headers,repo=self.id,scopes=['git:read'],sink=sink)

    async def get_archive(self, *, sink=None, **options):
        return await self.client.raw(self.path+'/archive','POST',json.dumps(options).encode(),headers={'Content-Type':'application/json'},repo=self.id,scopes=['git:read'],sink=sink)

    def create_commit(self, **options): return CommitBuilder(self, options)
    async def _stream(self, endpoint, lines):
        response = await self.client.raw(self.path+'/'+endpoint,'POST',((json.dumps(line,separators=(',',':'))+'\n').encode() for line in lines),headers={'Content-Type':'application/x-ndjson'},repo=self.id,scopes=['git:write'])
        return response.json()
    async def create_diff_commit(self, diff, **options):
        def lines():
            yield {'metadata':options}
            for part in _chunks(diff): yield {'diff_chunk':{'data':base64.b64encode(part).decode(),'eof':False}}
            yield {'diff_chunk':{'data':'','eof':True}}
        return await self._stream('diff-commit',lines())
    async def restore_commit(self, **options): return await self._stream('restore-commit',[{'metadata':options}])
    def git_url(self, namespace=None, authenticated=False, scopes=None):
        suffix = '+'+namespace if namespace else ''
        if namespace not in (None,'ephemeral','import'): raise ValueError('Invalid namespace')
        origin = self.client.origin
        if authenticated:
            token = self.client.token or create_token(**self.client.signer,repo=self.id,scopes=scopes or ['git:read','git:write'])
            parsed = urlsplit(origin)
            origin = parsed.scheme+'://x:'+quote(token,safe='')+'@'+parsed.netloc
        return origin+self.path.removeprefix('/repos')+suffix+'.git'

    async def get(self, **options):
        return await self._request('', 'GET', options, None)
    async def update(self, **options):
        return await self._request('', 'PATCH', options, 'repo:write')
    async def delete(self, **options):
        return await self._request('', 'DELETE', options, 'repo:write')
    async def list_branches(self, **options):
        return await self._request('branches', 'GET', options, None)
    async def get_branch(self, **options):
        return await self._request('branch', 'GET', options, None)
    async def create_branch(self, **options):
        return await self._request('branches/create', 'POST', options, None)
    async def delete_branch(self, **options):
        return await self._request('branches', 'DELETE', options, None)
    async def list_tags(self, **options):
        return await self._request('tags', 'GET', options, None)
    async def get_tag(self, **options):
        return await self._request('tag', 'GET', options, None)
    async def create_tag(self, **options):
        return await self._request('tags', 'POST', options, None)
    async def list_commits(self, **options):
        return await self._request('commits', 'GET', options, None)
    async def get_commit(self, **options):
        return await self._request('commit', 'GET', options, None)
    async def get_diff(self, **options):
        return await self._request('diff', 'GET', options, None)
    async def diff_branches(self, **options):
        return await self._request('branches/diff', 'GET', options, None)
    async def list_files(self, **options):
        return await self._request('files', 'GET', options, None)
    async def list_files_metadata(self, **options):
        return await self._request('files/metadata', 'GET', options, None)
    async def grep(self, **options):
        return await self._request('grep', 'POST', options, 'git:read')
    async def blame(self, **options):
        return await self._request('blame', 'GET', options, None)
    async def get_note(self, **options):
        return await self._request('notes', 'GET', options, None)
    async def create_note(self, **options):
        return await self._request('notes', 'POST', options, None)
    async def delete_note(self, **options):
        return await self._request('notes', 'DELETE', options, None)
    async def list_notes_refs(self, **options):
        return await self._request('notes/refs', 'GET', options, None)
    async def preview_merge(self, **options):
        return await self._request('merge/preview', 'GET', options, None)
    async def merge_branches(self, **options):
        return await self._request('merge', 'POST', options, None)
    async def unset_base_repo(self): return await self._request('base','DELETE',scope='repo:write')
    async def pull_upstream(self, **options):
        return await self._request('pull-upstream', 'POST', options, None)
    async def sync_status(self, **options):
        return await self._request('sync-status', 'GET', options, None)
    async def configure_upstream(self, **options):
        return await self._request('upstream', 'PUT', options, 'repo:write')
    async def list_git_credentials(self, **options):
        return await self._request('git-credentials', 'GET', options, 'repo:write')
    async def create_git_credential(self, **options):
        return await self._request('git-credentials', 'POST', options, 'repo:write')
    async def update_git_credential(self, **options):
        return await self._request('git-credentials', 'PUT', options, 'repo:write')
    async def list_webhooks(self, **options):
        return await self._request('webhooks', 'GET', options, None)
    async def create_webhook(self, **options):
        return await self._request('webhooks', 'POST', options, None)
    async def append_note(self, **options): return await self.create_note(**{**options,'operation':'append'})
    async def delete_tag(self, name, **options):
        return await self._request('tags/'+quote(name,safe='')+'?'+urlencode(options), 'DELETE', scope='git:write')
    async def delete_git_credential(self, id): return await self._request('git-credentials/'+quote(id,safe=''),'DELETE',scope='repo:write')
    async def delete_webhook(self, id): return await self._request('webhooks/'+quote(id,safe=''),'DELETE')

def _chunks(content):
    if isinstance(content,str): content=content.encode()
    if isinstance(content,bytes): content=io.BytesIO(content)
    if hasattr(content,'read'):
        while part:=content.read(1024*1024): yield part
    else:
        for part in content:
            for i in range(0,len(part),1024*1024): yield part[i:i+1024*1024]

class CommitBuilder:
    def __init__(self, repo, options): self.repo,self.options,self.files,self.used=repo,options,[],False
    def add_file(self,path,content,mode='100644'):
        if self.used: raise ValueError('Builder already sent')
        self.files.append((dict(path=path,mode=mode,operation='upsert',content_id=str(len(self.files))),content))
        return self
    def add_file_from_string(self,path,content,mode='100644'): return self.add_file(path,content,mode)
    def add_file_from_stream(self,path,content,mode='100644'): return self.add_file(path,content,mode)
    def delete_file(self,path):
        if self.used: raise ValueError('Builder already sent')
        self.files.append((dict(path=path,operation='delete',content_id=str(len(self.files))),None))
        return self
    delete_directory=delete_file
    async def send(self):
        if self.used: raise ValueError('Builder already sent')
        self.used=True
        def lines():
            yield {'metadata':{**self.options,'files':[f for f,_ in self.files]}}
            for file,content in self.files:
                if file['operation']=='delete': continue
                for part in _chunks(content): yield {'blob_chunk':{'content_id':file['content_id'],'data':base64.b64encode(part).decode(),'eof':False}}
                yield {'blob_chunk':{'content_id':file['content_id'],'data':'','eof':True}}
        return await self.repo._stream('commit-pack',lines())
