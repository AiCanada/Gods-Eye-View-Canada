"""The AI World tab's MLFLOW sections on the Python side: registering the kit's
world models (PyTorch and Keras) as pyfunc models, scoring them side by side
against persistence, and tracing a custom LLM's answer. Each test runs against
a throwaway local MLflow store (SQLite), as the CLIs run against the local
server; they skip when this Python has no MLflow (or no TensorFlow for the
Keras parts)."""

import importlib.util
import json
import os
import subprocess
import sys
import unittest

# MLflow's usage telemetry stays off here too, before mlflow is imported.
os.environ.setdefault("MLFLOW_DISABLE_TELEMETRY", "true")
os.environ.setdefault("DO_NOT_TRACK", "true")

from ml.gevtape import protocol, synth, train
from ml.tests.support import REPO_ROOT, TempDir, child_env

HAS_MLFLOW = importlib.util.find_spec("mlflow") is not None
HAS_TF = importlib.util.find_spec("tensorflow") is not None


def run_cli(module, *args, timeout=600):
    out = subprocess.run([sys.executable, "-m", module, *map(str, args)], cwd=REPO_ROOT, env=child_env(),
                         capture_output=True, text=True, timeout=timeout)
    events = [json.loads(line) for line in out.stdout.splitlines() if line.startswith("{")]
    return out.returncode, events, out.stderr


@unittest.skipUnless(HAS_MLFLOW, "no mlflow in this Python")
class MlflowRegistryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import mlflow

        cls.tmp = TempDir()
        cls.p = synth.make_gev_data(cls.tmp.path, scenarios=1, runs=1, days=3, bin_days=4, tape_hours=0,
                                    markets=("gold",))
        cls.uri = "sqlite:///" + (cls.tmp.path / "mlflow.db").as_posix()
        mlflow.set_tracking_uri(cls.uri)
        for name in ("ai-world/registry", "ai-world/evaluation", "ai-world/llm-traces"):
            mlflow.create_experiment(name, artifact_location=(cls.tmp.path / "artifacts" / name.split("/")[1]).as_uri())
        cls.world = cls.tmp.path / "world"
        args = train.parse_args(["--data", str(cls.p["root"]), "--model", "world", "--out", str(cls.world),
                                 "--epochs", "1", "--device", "cpu", "--hidden", "8", "--batch-size", "8",
                                 "--context", "12", "--horizon", "6", "--stride", "6"])
        assert train.run(args, lambda *a, **k: None, train.Control()) == 0
        cls.keras = None
        if HAS_TF:
            from ml.gevtape import tf_train

            cls.keras = cls.tmp.path / "tf-world"
            targs = tf_train.build_parser().parse_args([
                "--data", str(cls.p["root"]), "--out", str(cls.keras), "--epochs", "1", "--device", "cpu",
                "--hidden", "8", "--context", "12", "--horizon", "6", "--stride", "6"])
            assert tf_train.run(targs, lambda *a, **k: None, protocol.Control()) == 0
        cls.registered = {}
        code, events, err = run_cli("ml.gevtape.mlflow_register", "--tracking-uri", cls.uri, "--data", cls.p["root"],
                                    "--kind", "world", "--source", cls.world, "--name", "gev-world",
                                    "--alias", "champion")
        assert code == 0, err[-3000:]
        cls.registered["world"] = events
        if cls.keras is not None:
            code, events, err = run_cli("ml.gevtape.mlflow_register", "--tracking-uri", cls.uri, "--data",
                                        cls.p["root"], "--kind", "tf-world", "--source", cls.keras, "--name",
                                        "gev-tf-world", "--alias", "challenger")
            assert code == 0, err[-3000:]
            cls.registered["tf-world"] = events

    @classmethod
    def tearDownClass(cls):
        cls.tmp.close()

    def client(self):
        from mlflow import MlflowClient

        return MlflowClient(tracking_uri=self.uri)

    def test_a_world_model_is_a_registered_version_that_says_what_it_reads(self):
        events = self.registered["world"]
        done = [e for e in events if e["event"] == "registered"]
        self.assertEqual(len(done), 1)
        self.assertEqual((done[0]["name"], done[0]["version"], done[0]["alias"]), ("gev-world", "1", "champion"))
        self.assertEqual(events[-1]["event"], "done")
        client = self.client()
        mv = client.get_model_version_by_alias("gev-world", "champion")
        self.assertEqual(str(mv.version), "1")
        self.assertEqual(mv.tags["gev.kind"], "world")
        self.assertEqual(mv.tags["gev.context"], "12")
        self.assertEqual(mv.tags["gev.horizon"], "6")
        self.assertIn("markets.gold", json.loads(mv.tags["gev.channels"]))
        self.assertIn("gev.held-out.mae", mv.tags)
        run = client.get_run(mv.run_id)
        self.assertEqual(run.data.tags["gev.kind"], "world")
        self.assertIn("held-out/mae", run.data.metrics)

    def test_served_models_answer_one_request_shape_and_a_crop_without_the_graph(self):
        code = ("import json, sys, numpy as np, mlflow\n"
                f"mlflow.set_tracking_uri({self.uri!r})\n"
                "out = {}\n"
                "for name in sys.argv[1:]:\n"
                "    m = mlflow.pyfunc.load_model(f'models:/{name}/1')\n"
                "    tags = mlflow.MlflowClient().get_model_version(name, '1').tags\n"
                "    C = len(json.loads(tags['gev.channels'])); L = 18; K = 4\n"
                "    x = {'v': np.zeros((2, L, K, C), np.float32), 'm': np.zeros((2, L, K, C), np.float32),\n"
                "         'tf': np.zeros((2, L, K, 6), np.float32), 's': np.zeros((2, K, int(tags['gev.nStatic'])), np.float32)}\n"
                "    x['v'][:, 5, :, 0] = 2.0; x['m'][:, 5, :, 0] = 1.0\n"
                "    y = np.asarray(m.predict(x))\n"
                "    out[name] = {'shape': list(y.shape), 'C': C}\n"
                "print(json.dumps(out))\n")
        names = ["gev-world"] + (["gev-tf-world"] if self.keras is not None else [])
        out = subprocess.run([sys.executable, "-c", code, *names], cwd=REPO_ROOT, env=child_env(),
                             capture_output=True, text=True, timeout=600)
        self.assertEqual(out.returncode, 0, out.stderr[-3000:])
        shapes = json.loads(out.stdout.strip().splitlines()[-1])
        for name in names:
            self.assertEqual(shapes[name]["shape"], [2, 6, 4, shapes[name]["C"]], name)

    def test_evaluation_scores_every_registered_world_model_against_persistence(self):
        code, events, err = run_cli("ml.gevtape.mlflow_evaluate", "--tracking-uri", self.uri, "--data",
                                    self.p["root"], "--eval-windows", "4")
        self.assertEqual(code, 0, err[-3000:])
        result = next(e for e in events if e["event"] == "evaluation")
        names = {(r["name"], r["version"]) for r in result["rows"]}
        self.assertIn(("gev-world", "1"), names)
        if self.keras is not None:
            self.assertIn(("gev-tf-world", "1"), names)
        for row in result["rows"]:
            self.assertIsNotNone(row["mae"], row)
            self.assertGreater(row["persistence"], 0, row)
            self.assertEqual(row["windows"], 4)
        self.assertIn(result["best"]["name"], {n for n, _ in names})
        client = self.client()
        self.assertIn("gev.eval.mae", client.get_model_version("gev-world", "1").tags)
        run = client.get_run(result["runId"])
        self.assertIn("gev-world.v1/mae", run.data.metrics)
        self.assertEqual(run.data.tags["gev.best"], f"{result['best']['name']} v{result['best']['version']}")

    def test_an_answer_is_kept_as_a_trace_with_its_question(self):
        code = ("import json, mlflow\n"
                "from ml.gevtape import llm_chat\n"
                f"mlflow.set_tracking_uri({self.uri!r})\n"
                "mlflow.set_experiment('ai-world/llm-traces')\n"
                "with llm_chat.traced('custom LLM', {'prompt': 'What moved before crude oil?'},\n"
                "                     {'gev.model': 'test'}) as (set_outputs, box):\n"
                "    set_outputs({'answer': 'Shipping.'})\n"
                "trace = mlflow.get_trace(box['traceId'], flush=True)\n"
                "print(json.dumps({'id': box['traceId'], 'state': str(trace.info.state),\n"
                "                  'request': trace.data.request, 'response': trace.data.response}))\n")
        out = subprocess.run([sys.executable, "-c", code], cwd=REPO_ROOT, env=child_env(), capture_output=True,
                             text=True, timeout=300)
        self.assertEqual(out.returncode, 0, out.stderr[-3000:])
        got = json.loads(out.stdout.strip().splitlines()[-1])
        self.assertTrue(got["id"])
        self.assertIn("What moved before crude oil?", got["request"])
        self.assertIn("Shipping.", got["response"])

    def test_a_model_that_is_not_there_is_an_error_on_the_protocol(self):
        code, events, _ = run_cli("ml.gevtape.mlflow_register", "--tracking-uri", self.uri, "--data", self.p["root"],
                                  "--kind", "world", "--source", self.tmp.path / "nothing", "--name", "x")
        self.assertEqual(code, 1)
        self.assertEqual(events[-1]["event"], "error")
        self.assertIn("checkpoint.pt", events[-1]["message"])


class ProbeTest(unittest.TestCase):
    def test_the_probe_names_each_package_or_null(self):
        code, events, err = run_cli("ml.gevtape.mlflow_probe", timeout=120)
        self.assertEqual(code, 0, err)
        probe = events[0]
        self.assertEqual(probe["event"], "probe")
        self.assertEqual(probe["mlflow"] is not None, HAS_MLFLOW)
        self.assertTrue(probe["python"].startswith("3."))


if __name__ == "__main__":
    unittest.main()
