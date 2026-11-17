import BasicAnimationManager from 'tests/osgAnimation/BasicAnimationManager';
import Interpolator from 'tests/osgAnimation/Interpolator';
import RigGeometry from 'tests/osgAnimation/RigGeometry';
import StackedTransform from 'tests/osgAnimation/StackedTransform';

export default function() {
    BasicAnimationManager();
    Interpolator();
    RigGeometry();
    StackedTransform();
}
