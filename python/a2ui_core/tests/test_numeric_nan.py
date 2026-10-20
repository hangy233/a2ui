# Copyright 2024 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from typing import Any

import pytest

from a2ui.core import DataContext, SurfaceModel
from a2ui.core.basic_catalog import BasicCatalog


def _numeric_result(protocol_version: str, value: Any, bounds: dict[str, int]) -> Any:
    surface = SurfaceModel("numeric", BasicCatalog(protocol_version))
    errors: list[Any] = []
    surface.on_error.subscribe(errors.append)
    surface.data_model.set("/input", value)
    directive = "@" if protocol_version == "1.0" else ""
    try:
        result = DataContext(surface).resolve_dynamic_value({
            f"{directive}call": "numeric",
            "args": {"value": {f"{directive}path": "/input"}, **bounds},
        })
        assert errors == []
        return result
    finally:
        surface.dispose()


@pytest.mark.parametrize("protocol_version", ["0.9", "1.0"])
@pytest.mark.parametrize("value", ["NaN", "nan", "+NaN", "-NaN", float("nan")])
@pytest.mark.parametrize("bounds", [{}, {"min": 0, "max": 10}])
def test_numeric_rejects_bound_nan(
    protocol_version: str, value: Any, bounds: dict[str, int]
) -> None:
    result = _numeric_result(protocol_version, value, bounds)
    if protocol_version == "1.0":
        assert result == {"valid": False}
    else:
        assert result is False


@pytest.mark.parametrize("protocol_version", ["0.9", "1.0"])
@pytest.mark.parametrize(
    ("value", "bounds", "valid"),
    [
        (42, {}, True),
        ("42.5", {}, True),
        (0, {"min": 0, "max": 10}, True),
        (10, {"min": 0, "max": 10}, True),
        ("-1", {"min": 0, "max": 10}, False),
        ("11", {"min": 0, "max": 10}, False),
        ("not-a-number", {}, False),
    ],
)
def test_numeric_preserves_bound_number_validation(
    protocol_version: str, value: Any, bounds: dict[str, int], valid: bool
) -> None:
    result = _numeric_result(protocol_version, value, bounds)
    if protocol_version == "1.0":
        assert result == {"valid": valid}
    else:
        assert result is valid
