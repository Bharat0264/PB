import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock

from botocore.exceptions import ClientError
import file_retention as retention
import fulfillment as ops
from order_documents import PrivateFiles
from test_e2e_workflow import Customer, RIDER_KEYS, Server, closing_db


ORDER = 'a' * 32
OTHER = 'b' * 32


class FileRetentionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'files.sqlite'
        self.db = self.connect()
        self.addCleanup(self.db.close)
        self.db.executescript(ops.SCHEMA + """
            CREATE TABLE orders(id TEXT PRIMARY KEY, status TEXT, details TEXT);
            CREATE TABLE files(order_id TEXT, position INTEGER, content BLOB, object_key TEXT);
        """)
        with self.db:
            self.db.execute("INSERT INTO orders VALUES (?,'out_for_delivery','{}')", (ORDER,))
            self.db.execute("INSERT INTO orders VALUES (?,'paid','{}')", (OTHER,))
            self.db.executemany("INSERT INTO files VALUES (?,?,?,NULL)", [(ORDER, 0, b'private pdf'), (ORDER, 1, b'private jpg'), (OTHER, 0, b'keep')])
            self.db.execute("INSERT INTO deliveries(order_id,partner,nonce,expires) VALUES (?,'rider','nonce',?)", (ORDER, int(time.time()) + 3600))
        self.code = ops.delivery_code(b'secret', 'nonce')

    def connect(self):
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA secure_delete=ON')
        return db

    def deliver(self):
        return ops.deliver(self.db, ORDER, 'rider', b'secret', self.code)

    def test_correct_otp_deletes_all_local_files_and_keeps_other_orders(self):
        with self.db:
            self.assertIsNone(self.deliver())
        self.assertEqual(self.db.execute('SELECT count(*) FROM files WHERE order_id=?', (ORDER,)).fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT content FROM files WHERE order_id=?', (OTHER,)).fetchone()[0], b'keep')
        self.assertEqual(self.db.execute('SELECT count(*) FROM partner_earnings').fetchone()[0], 1)
        self.assertIsNotNone(self.db.execute('SELECT completed FROM file_deletions').fetchone()[0])
        self.assertIsNotNone(self.deliver())  # a replay cannot delete again or pay twice
        self.assertEqual(self.db.execute('SELECT count(*) FROM partner_earnings').fetchone()[0], 1)

    def test_invalid_expired_or_other_partner_otp_never_deletes(self):
        bad = f'{(int(self.code)+1)%10000:04d}'
        with self.db:
            self.assertIsNotNone(ops.deliver(self.db, ORDER, 'rider', b'secret', bad))
            self.assertIsNotNone(ops.deliver(self.db, ORDER, 'another', b'secret', self.code))
            self.db.execute('UPDATE deliveries SET expires=0')
            self.assertIsNotNone(self.deliver())
        self.assertEqual(self.db.execute('SELECT count(*) FROM files').fetchone()[0], 3)
        self.assertEqual(self.db.execute('SELECT count(*) FROM file_deletions').fetchone()[0], 0)

    def test_delivery_and_deletion_rollback_together(self):
        with self.assertRaises(RuntimeError):
            with self.db:
                self.deliver()
                raise RuntimeError('transaction failed')
        self.assertEqual(self.db.execute('SELECT status FROM orders WHERE id=?', (ORDER,)).fetchone()[0], 'out_for_delivery')
        self.assertEqual(self.db.execute('SELECT count(*) FROM files').fetchone()[0], 3)
        self.assertEqual(self.db.execute('SELECT count(*) FROM file_deletions').fetchone()[0], 0)

    def test_remote_job_survives_missing_storage_failure_and_restart(self):
        with self.db:
            self.db.execute('UPDATE files SET content=NULL,object_key=? WHERE order_id=? AND position=0', ('printbee/orders/'+ORDER+'/0/hash', ORDER))
            self.deliver()
        retention.process_deletions(self.connect, None)
        cloud = Mock()
        cloud.delete_order.side_effect = OSError('private connection detail')
        retention.process_deletions(self.connect, cloud)
        job = self.db.execute('SELECT * FROM file_deletions').fetchone()
        self.assertIsNone(job['completed'])
        self.assertEqual(job['attempts'], 2)
        self.assertEqual(job['last_error'], 'OSError')
        cloud.delete_order.side_effect = None
        retention.process_deletions(self.connect, cloud)
        self.assertIsNotNone(self.db.execute('SELECT completed FROM file_deletions').fetchone()[0])
        retention.process_deletions(self.connect, cloud)
        self.assertEqual(cloud.delete_order.call_count, 2)  # completed jobs do not repeat

    def test_recovery_requires_verified_delivery_audit(self):
        with self.db:
            self.db.execute("UPDATE orders SET status='delivered'")
            ops.audit(self.db, 'rider', 'delivery_completed', ORDER)
            retention.recover_verified_deliveries(self.db)
        self.assertEqual(self.db.execute('SELECT order_id FROM files').fetchall()[0][0], OTHER)
        self.assertEqual(self.db.execute('SELECT count(*) FROM files').fetchone()[0], 1)


class CloudDeletionTests(unittest.TestCase):
    def setUp(self):
        self.storage = object.__new__(PrivateFiles)
        self.storage.bucket = 'private-test-bucket'
        self.storage.errors = (ClientError,)
        self.storage.client = Mock()
        self.storage.client.delete_objects.return_value = {}
        self.prefix = 'printbee/orders/' + ORDER + '/'

    def test_deletes_all_versions_replaced_uploads_and_delete_markers(self):
        pages = [{'Versions': [{'Key': self.prefix+'0/old', 'VersionId': 'old'}, {'Key': self.prefix+'0/new', 'VersionId': 'new'}],
                  'DeleteMarkers': [{'Key': self.prefix+'0/old', 'VersionId': 'marker'}]}]
        self.storage.client.get_paginator.return_value.paginate.return_value = pages
        self.storage.delete_order(ORDER)
        objects = self.storage.client.delete_objects.call_args.kwargs['Delete']['Objects']
        self.assertEqual(len(objects), 3)
        self.assertEqual({item['VersionId'] for item in objects}, {'old','new','marker'})
        self.storage.client.get_paginator.return_value.paginate.assert_called_once_with(Bucket='private-test-bucket', Prefix=self.prefix)

    def test_s3_compatible_unversioned_fallback(self):
        unsupported = Mock()
        unsupported.paginate.side_effect = ClientError({'Error': {'Code': 'NotImplemented'}}, 'ListObjectVersions')
        current = Mock()
        current.paginate.return_value = [{'Contents': [{'Key':self.prefix+'0/file'}]}]
        self.storage.client.get_paginator.side_effect = [unsupported, current]
        self.storage.delete_order(ORDER)
        self.assertEqual(self.storage.client.delete_objects.call_args.kwargs['Delete']['Objects'], [{'Key':self.prefix+'0/file'}])

    def test_partial_failure_or_wrong_prefix_is_not_reported_as_deleted(self):
        self.storage.client.get_paginator.return_value.paginate.return_value = [{'Versions':[{'Key':self.prefix+'0/file','VersionId':'one'}]}]
        self.storage.client.delete_objects.return_value = {'Errors':[{'Code':'AccessDenied'}]}
        with self.assertRaises(OSError): self.storage.delete_order(ORDER)
        self.storage.client.get_paginator.return_value.paginate.return_value = [{'Versions':[{'Key':'printbee/support/keep','VersionId':'one'}]}]
        with self.assertRaises(ValueError): self.storage.delete_order(ORDER)
        with self.assertRaises(ValueError): self.storage.delete_order('../')


class OTPFileDeletionHTTPTests(unittest.TestCase):
    def test_verified_handover_removes_downloads_but_keeps_receipt_and_history(self):
        server = Server()
        self.addCleanup(server.stop)
        customer = Customer(server, 'retention@example.test')
        order = customer.order()
        customer.pay(order)
        file_path = f"/api/orders/{order['id']}/files/0"
        self.assertEqual(customer.get(file_path)[0], 200)
        warehouse = {'X-Staff-Key':server.keys['warehouse']}
        self.assertEqual(server.request('POST', f"/api/staff/orders/{order['id']}/printed/0", {}, warehouse)[0], 200)
        rider = {'X-Staff-Key': RIDER_KEYS['rider-a']}
        server.request('POST','/api/partner/availability',{'available':True},rider)
        path = f"/api/partner/orders/{order['id']}"
        self.assertEqual(server.request('POST',path+'/accept',{},rider)[0],200)
        self.assertEqual(server.request('POST',path+'/pickup',{},rider)[0],200)
        code = customer.view(order)['delivery']['code']
        bad = f'{(int(code)+1)%10000:04d}'
        self.assertEqual(server.request('POST',path+'/deliver',{'code':bad},rider)[0],409)
        self.assertEqual(customer.get(file_path)[0],200)
        self.assertEqual(server.request('POST',path+'/deliver',{'code':code})[0],403)
        self.assertEqual(customer.get(file_path)[0],200)
        self.assertEqual(server.request('POST',path+'/deliver',{'code':code},rider)[0],200)
        self.assertEqual(customer.get(file_path)[0],410)
        self.assertEqual(customer.get(file_path+'?download=1')[0],410)
        self.assertEqual(server.request('GET',f"/api/staff/files/{order['id']}/0",headers=warehouse)[0],404)
        status, receipt, _ = customer.get(f"/api/orders/{order['id']}/invoice")
        self.assertEqual(status,200)
        self.assertTrue(receipt.startswith(b'%PDF'))
        self.assertEqual(customer.view(order)['status'],'delivered')
        with closing_db(server) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM files WHERE order_id=?',(order['id'],)).fetchone()[0],0)
            self.assertEqual(db.execute('SELECT count(*) FROM partner_earnings WHERE order_id=?',(order['id'],)).fetchone()[0],1)


if __name__ == '__main__':
    unittest.main()
