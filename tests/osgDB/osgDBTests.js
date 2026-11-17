import Input from 'tests/osgDB/Input';
import ReaderParser from 'tests/osgDB/ReaderParser';
import DatabasePager from 'tests/osgDB/DatabasePager';
import ReaderWriterGLTF from 'tests/osgDB/ReaderWriterGLTF';

export default function() {
    Input();
    ReaderParser();
    DatabasePager();
    ReaderWriterGLTF();
}
