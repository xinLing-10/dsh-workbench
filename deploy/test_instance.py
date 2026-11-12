import unittest
from instance import configuration
class ConfigurationTests(unittest.TestCase):
    def test_instances_have_separate_volumes_and_networks(self):
        a=configuration('alice',3081,'image:a');b=configuration('bob',3082,'image:a')
        self.assertNotEqual(a['name'],b['name'])
        self.assertEqual(a['services']['workbench']['ports'],['127.0.0.1:3081:3080'])
        self.assertEqual(b['services']['workbench']['ports'],['127.0.0.1:3082:3080'])
        service=a['services']['workbench']
        self.assertTrue(service['read_only']);self.assertEqual(service['cap_drop'],['ALL'])
        self.assertFalse(any('docker.sock' in v for v in service['volumes']))
    def test_rejects_invalid_names_ports_and_urls(self):
        for name in ['../other','a/b','UPPER','a;true','', 'a'*32]:
            with self.assertRaises(ValueError):configuration(name,3081,'image:a')
        for port in [0,80,65536]:
            with self.assertRaises(ValueError):configuration('alice',port,'image:a')
        for url in ['http://example.com','https://example.com/path','https://a:b@example.com','https://example.com/?token=a']:
            with self.assertRaises(ValueError):configuration('alice',3081,'image:a',url)
    def test_https_origin_is_passed_to_host(self):
        c=configuration('alice',3081,'image:a','https://alice.example.com/')
        self.assertEqual(c['services']['workbench']['environment']['WORKBENCH_PUBLIC_URL'],'https://alice.example.com/')
if __name__=='__main__': unittest.main()
