'use strict';

window.addEventListener(
    'load',
    function() {
        var osg = window.OSG.osg;
        var viewer = new window.OSG.osgViewer.Viewer(document.getElementById('View'));
        viewer.init();
        viewer.getCamera().setClearColor([0.004, 0.008, 0.02, 1]);
        var scene = new osg.Node();
        var lights = new osg.LightPointNode();
        lights.setMinPixelSize(1.5);
        lights.setMaxPixelSize(50);
        lights.setMaxVisibleDistance2(4000000);
        for (var i = 0; i < 80; i++) {
            for (var side = -1; side <= 1; side += 2) {
                var color = i < 8 ? [0.2, 1, 0.45, 1] : [1, 0.68, 0.3, 1];
                var point = new osg.LightPoint([side * 12, i * 5, 0.15], color);
                point.setRadius(0.7);
                point.setBlendingMode(osg.LightPoint.ADDITIVE);
                lights.addLightPoint(point);
            }
        }
        scene.addChild(lights);
        var ground = osg.createTexturedBoxGeometry(0, 195, -0.5, 32, 410, 1);
        var material = new osg.Material();
        material.setDiffuse([0.025, 0.03, 0.045, 1]);
        ground.getOrCreateStateSet().setAttributeAndModes(material);
        scene.addChild(ground);
        viewer.setSceneData(scene);
        viewer.setupManipulator();
        viewer.getManipulator().setEyePosition([55, -60, 35]);
        viewer.getManipulator().setTarget([0, 120, 0]);
        viewer.run();
    },
    true
);
