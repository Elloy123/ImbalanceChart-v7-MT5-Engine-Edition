from abc import ABC, abstractmethod
from typing import Dict, Any

class VolumeEngine(ABC):
    """Interface base para engines de análise de volume."""
    
    @abstractmethod
    def analyze(self, tick: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
        """Analisa um tick e retorna metadados. Signal: -1.0 a +1.0"""
        pass
    
    def reset(self):
        """Reset state (ex: troca de símbolo)."""
        pass
