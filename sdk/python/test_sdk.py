import asyncio,io,json,os,unittest,uuid,base64
from onestorage import OneStorage,create_token
from cryptography.hazmat.primitives.asymmetric import ec,rsa,utils,padding
from cryptography.hazmat.primitives import serialization,hashes
class SDKTests(unittest.TestCase):
    def test_jwt_algorithms(self):
        for algorithm,curve,digest in [('ES256',ec.SECP256R1(),hashes.SHA256()),('ES384',ec.SECP384R1(),hashes.SHA384()),('ES512',ec.SECP521R1(),hashes.SHA512()),('RS256',None,hashes.SHA256())]:
            key=ec.generate_private_key(curve) if curve else rsa.generate_private_key(public_exponent=65537,key_size=2048)
            pem=key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption())
            token=create_token(issuer='owner',key=pem,scopes=['git:read'],repo='owner/repo',algorithm=algorithm)
            h,c,s=token.split('.');signature=base64.urlsafe_b64decode(s+'='*(-len(s)%4))
            if curve:
                width=len(signature)//2;signature=utils.encode_dss_signature(int.from_bytes(signature[:width],'big'),int.from_bytes(signature[width:],'big'))
                key.public_key().verify(signature,(h+'.'+c).encode(),ec.ECDSA(digest))
            else:key.public_key().verify(signature,(h+'.'+c).encode(),padding.PKCS1v15(),digest)
    @unittest.skipUnless(os.getenv('TEST_ORIGIN'),'local integration origin required')
    def test_integration(self):
        async def run():
            client=OneStorage(os.environ['TEST_ORIGIN'],signer=dict(issuer=os.environ['TEST_ISSUER'],key=os.environ['TEST_PRIVATE_KEY'],key_id=os.environ['TEST_KEY_ID']))
            project=await client.create_repo(name='e2e_sdk_py_'+uuid.uuid4().hex[:8]);repo=client.repo(project['namespace'],project['name'])
            try:
                self.assertEqual((await client.resolve_repo(project['id']))['id'],project['id'])
                commit=await repo.create_commit(target_branch='main',commit_message='Python SDK',author={'name':'Python','email':'py@example.com'}).add_file('binary',io.BytesIO(b'\x00\x01\xff')).add_file_from_string('README.md','Python\n').send()
                self.assertTrue(commit['sha']);self.assertEqual((await repo.get_file('binary')).body,b'\x00\x01\xff')
                await repo.create_note(sha=commit['sha'],note='verified');self.assertEqual((await repo.get_note(sha=commit['sha']))['note'],'verified\n')
                await repo.create_branch(target_branch='agent',base_branch='main',ephemeral=True);self.assertEqual(len((await repo.list_branches(ephemeral=True))['branches']),1)
                archive=io.BytesIO();await repo.get_archive(sink=archive);self.assertEqual(archive.getvalue()[:2],b'\x1f\x8b')
            finally:await repo.delete()
        asyncio.run(run())
if __name__=='__main__':unittest.main()
